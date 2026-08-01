import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


import {
  PREVIEW_TEMP_PREFIX,
  normalizeChildExitCode,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
} from "./environment";
import type { PreviewHarnessDependencies } from "./harness";
import {
  authorizePreviewWithManagedOAuth,
  openPreviewAuthorizationURL,
} from "./managed-oauth";
import {
  capturePreviewTempDirectoryOwnership,
  registerPreviewExitCleanup,
  removePreviewTempDirectory,
  removePreviewTempDirectorySync,
} from "./temp-cleanup";

export {
  registerPreviewExitCleanup,
  removePreviewTempDirectory,
  removePreviewTempDirectorySync,
};

interface PreviewSuiteOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: (
    executable: string,
    arguments_: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ) => ChildProcess;
  writeOutput?: (text: string, destination: "stdout" | "stderr") => void;
  terminationGraceMilliseconds?: number;
  terminationFallbackMilliseconds?: number;
}
const DEFAULT_TERMINATION_GRACE_MILLISECONDS = 2_000;
const DEFAULT_TERMINATION_FALLBACK_MILLISECONDS = 2_000;

export async function createPreviewTempDirectory(): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), PREVIEW_TEMP_PREFIX));
  await chmod(tempDirectory, 0o700);
  return tempDirectory;
}

export function createPreviewSignalHandler(
  shutdown: (signal: NodeJS.Signals) => Promise<void>,
  unregister: () => void,
  relaySignal: (signal: NodeJS.Signals) => void,
  fallbackCleanup: () => void = () => undefined,
): (signal: NodeJS.Signals) => Promise<void> {
  let handlingPromise: Promise<void> | undefined;
  return (signal) => {
    handlingPromise ??= (async () => {
      let shutdownCompleted = false;
      try {
        await shutdown(signal);
        shutdownCompleted = true;
      } finally {
        if (!shutdownCompleted) {
          try {
            fallbackCleanup();
          } catch {
            // Refusal is fail-closed; signal relay must still complete.
          }
        }
        unregister();
        relaySignal(signal);
      }
    })();
    return handlingPromise;
  };
}

export function registerPreviewSignalCleanup(
  cleanup: (signal: NodeJS.Signals) => Promise<void>,
  fallbackCleanup: () => void,
): () => void {
  const listeners = new Map<NodeJS.Signals, () => void>();
  let registered = true;
  const unregister = () => {
    if (!registered) return;
    registered = false;
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
  const handler = createPreviewSignalHandler(cleanup, unregister, (signal) => {
    process.kill(process.pid, signal);
  }, fallbackCleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => { void handler(signal).catch(() => undefined); };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  return unregister;
}

export function previewNpxExecutable(
  platform: NodeJS.Platform = process.platform,
): "npx" | "npx.cmd" {
  return platform === "win32" ? "npx.cmd" : "npx";
}

function abortSignalName(signal: AbortSignal): NodeJS.Signals {
  return signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
}

export async function runPreviewSuite(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal = new AbortController().signal,
  options: PreviewSuiteOptions = {},
): Promise<number> {
  resolvePreviewRuntimeEnvironment(env);
  const writeOutput = options.writeOutput ?? ((text, destination) => {
    process[destination].write(text);
  });
  if (signal.aborted) {
    writeOutput("Preview checks failed; re-authenticate and retry.\n", "stderr");
    return 1;
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  return await new Promise((resolve) => {
    const child = spawnProcess(
      previewNpxExecutable(options.platform),
      ["playwright", "test", "--config", "playwright.preview.config.ts"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let fallbackTimer: NodeJS.Timeout | undefined;
    const clearTerminationTimers = () => {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    };
    const abortListener = () => {
      try {
        child.kill(abortSignalName(signal));
      } catch {
        // Escalation and fallback below still bound shutdown.
      }
      if (settled) return;
      graceTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The bounded fallback still releases cleanup.
        }
        fallbackTimer = setTimeout(
          () => settle(1),
          options.terminationFallbackMilliseconds ??
            DEFAULT_TERMINATION_FALLBACK_MILLISECONDS,
        );
      }, options.terminationGraceMilliseconds ?? DEFAULT_TERMINATION_GRACE_MILLISECONDS);
    };
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTerminationTimers();
      signal.removeEventListener("abort", abortListener);
      const resultCode = signal.aborted ? 1 : code;
      if (resultCode === 0) {
        if (stdout.length > 0) writeOutput(stdout.join(""), "stdout");
        if (stderr.length > 0) writeOutput(stderr.join(""), "stderr");
      } else {
        writeOutput("Preview checks failed; re-authenticate and retry.\n", "stderr");
      }
      resolve(resultCode);
    };
    child.once("error", () => settle(1));
    child.once("close", (code, childSignal) => {
      settle(normalizeChildExitCode(code, childSignal));
    });
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
}

export function createNodePreviewHarnessDependencies(): PreviewHarnessDependencies {
  return {
    createTempDirectory: async () => capturePreviewTempDirectoryOwnership(
      await createPreviewTempDirectory(),
    ),
    removeTempDirectory: removePreviewTempDirectory,
    removeTempDirectorySync: removePreviewTempDirectorySync,
    registerExitCleanup: registerPreviewExitCleanup,
    registerSignalCleanup: registerPreviewSignalCleanup,
    authorizePreview: (input, signal) =>
      authorizePreviewWithManagedOAuth(
        input,
        { openAuthorizationURL: openPreviewAuthorizationURL },
        signal,
      ),
    runPreviewSuite,
  };
}
