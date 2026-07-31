import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { chromium } from "@playwright/test";

import {
  PREVIEW_TEMP_PREFIX,
  assertAuthenticationNavigation,
  assertProtectedTemporaryDirectory,
  normalizeChildExitCode,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
  resolvePreviewStorageStatePath,
} from "./environment";
import type { PreviewHarnessDependencies } from "./harness";

interface PreviewFrame {
  url(): string;
}

interface PreviewPage {
  on(event: "framenavigated", listener: (frame: PreviewFrame) => void): unknown;
  off(event: "framenavigated", listener: (frame: PreviewFrame) => void): unknown;
  mainFrame(): PreviewFrame;
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  waitForURL(url: string, options: { timeout: number }): Promise<unknown>;
  waitForFunction(
    pageFunction: () => boolean,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
}

interface PreviewContext {
  newPage(): Promise<PreviewPage>;
  storageState(input: { path: string }): Promise<unknown>;
}

interface PreviewBrowser {
  newContext(): Promise<PreviewContext>;
  close(): Promise<void>;
}

interface PreviewChromium {
  launch(options: { headless: boolean }): Promise<PreviewBrowser>;
}

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
}

export async function createPreviewTempDirectory(
  systemTempDirectory = tmpdir(),
): Promise<string> {
  const tempDirectory = await mkdtemp(join(systemTempDirectory, PREVIEW_TEMP_PREFIX));
  await chmod(tempDirectory, 0o700);
  return tempDirectory;
}

export async function removePreviewTempDirectory(
  tempDirectory: string,
  systemTempDirectory = tmpdir(),
): Promise<void> {
  await rm(assertProtectedTemporaryDirectory(tempDirectory, systemTempDirectory), {
    force: true,
    recursive: true,
  });
}

function isPlaywrightNavigationError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "TimeoutError" ||
    /(?:navigation|timeout|timed out|net::err)/i.test(error.message)
  );
}

async function resolveCaptureAccessStateInput(input: {
  baseURL: string;
  storageStatePath: string;
}): Promise<{ baseURL: string; storageStatePath: string }> {
  const baseURL = resolvePreviewBaseURL(input.baseURL);
  let storageStatePath: string;
  try {
    const tempDirectory = assertProtectedTemporaryDirectory(
      dirname(input.storageStatePath),
    );
    storageStatePath = resolvePreviewStorageStatePath(
      tempDirectory,
      input.storageStatePath,
    );
  } catch {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  try {
    await lstat(storageStatePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { baseURL, storageStatePath };
    throw new Error("Preview storage state must be absent before authentication");
  }
  throw new Error("Preview storage state must be absent before authentication");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function protectCapturedStorageState(storageStatePath: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      storageStatePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    await handle.chmod(0o600);
    const [after, leaf] = await Promise.all([handle.stat(), lstat(storageStatePath)]);
    if (
      !after.isFile() ||
      (after.mode & 0o777) !== 0o600 ||
      leaf.isSymbolicLink() ||
      !leaf.isFile() ||
      (leaf.mode & 0o777) !== 0o600 ||
      leaf.dev !== after.dev ||
      leaf.ino !== after.ino
    ) {
      throw new Error("unsafe storage state");
    }
  } catch {
    throw new Error("Preview storage state was not captured securely");
  } finally {
    await handle?.close();
  }
}

export async function capturePreviewAccessState(
  input: { baseURL: string; storageStatePath: string },
  browserDriver: PreviewChromium = chromium,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const { baseURL, storageStatePath } = await resolveCaptureAccessStateInput(input);
  if (signal.aborted) throw new Error("Preview harness terminated.");
  const browser = await browserDriver.launch({ headless: false });
  let closePromise: Promise<void> | undefined;
  const closeBrowser = () => {
    closePromise ??= browser.close();
    return closePromise;
  };
  let rejectAbort: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortListener = () => {
    void closeBrowser().catch(() => undefined);
    rejectAbort(new Error("Preview harness terminated."));
  };
  signal.addEventListener("abort", abortListener, { once: true });
  let authentication: Promise<void> | undefined;
  try {
    authentication = (async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      let rejectUnexpectedNavigation: (reason: unknown) => void = () => undefined;
      const unexpectedNavigation = new Promise<never>((_resolve, reject) => {
        rejectUnexpectedNavigation = reject;
      });
      const navigationListener = (frame: PreviewFrame) => {
        if (frame !== page.mainFrame()) return;
        try {
          assertAuthenticationNavigation(frame.url());
        } catch (error) {
          rejectUnexpectedNavigation(error);
        }
      };
      page.on("framenavigated", navigationListener);
      try {
        await Promise.race([
          unexpectedNavigation,
          (async () => {
            await page.goto(`${baseURL}/health`, { waitUntil: "domcontentloaded" });
            await page.waitForURL(`${baseURL}/health`, { timeout: 300_000 });
            await page.waitForFunction(
              () => document.body.textContent?.trim() === '{"status":"ok"}',
              undefined,
              { timeout: 300_000 },
            );
            await context.storageState({ path: storageStatePath });
            await protectCapturedStorageState(storageStatePath);
          })(),
        ]);
      } finally {
        page.off("framenavigated", navigationListener);
      }
    })();
    if (signal.aborted) abortListener();
    try {
      await Promise.race([authentication, aborted]);
    } catch (error) {
      if (signal.aborted) throw new Error("Preview harness terminated.");
      if (isPlaywrightNavigationError(error)) {
        throw new Error("Preview authentication did not complete; retry the command.");
      }
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", abortListener);
    await closeBrowser();
    if (signal.aborted) await authentication?.catch(() => undefined);
  }
}

export function createPreviewSignalHandler(
  shutdown: (signal: NodeJS.Signals) => Promise<void>,
  unregister: () => void,
  relaySignal: (signal: NodeJS.Signals) => void,
): (signal: NodeJS.Signals) => Promise<void> {
  let handlingPromise: Promise<void> | undefined;
  return (signal) => {
    handlingPromise ??= (async () => {
      try {
        await shutdown(signal);
      } finally {
        unregister();
        relaySignal(signal);
      }
    })();
    return handlingPromise;
  };
}

export function registerPreviewSignalCleanup(
  cleanup: (signal: NodeJS.Signals) => Promise<void>,
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
  });
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
    const abortListener = () => {
      child.kill(abortSignalName(signal));
    };
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortListener);
      if (code === 0) {
        if (stdout.length > 0) writeOutput(stdout.join(""), "stdout");
        if (stderr.length > 0) writeOutput(stderr.join(""), "stderr");
      } else {
        writeOutput("Preview checks failed; re-authenticate and retry.\n", "stderr");
      }
      resolve(code);
    };
    child.once("error", () => settle(1));
    child.once("exit", (code, childSignal) => {
      settle(normalizeChildExitCode(code, childSignal));
    });
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
}

export function createNodePreviewHarnessDependencies(): PreviewHarnessDependencies {
  return {
    createTempDirectory: createPreviewTempDirectory,
    removeTempDirectory: removePreviewTempDirectory,
    registerSignalCleanup: registerPreviewSignalCleanup,
    captureAccessState: (input, signal) =>
      capturePreviewAccessState(input, chromium, signal),
    runPreviewSuite,
  };
}
