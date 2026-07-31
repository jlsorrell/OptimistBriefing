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
  storageState(): Promise<unknown>;
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

export async function removePreviewTempDirectory(
  tempDirectory: string,
): Promise<void> {
  await rm(assertProtectedTemporaryDirectory(tempDirectory), {
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
}): Promise<{
  baseURL: string;
  tempDirectory: string;
  tempDirectoryDevice: number;
  tempDirectoryInode: number;
  storageStatePath: string;
}> {
  const baseURL = resolvePreviewBaseURL(input.baseURL);
  let tempDirectory: string;
  let storageStatePath: string;
  let tempDirectoryDevice: number;
  let tempDirectoryInode: number;
  try {
    tempDirectory = assertProtectedTemporaryDirectory(
      dirname(input.storageStatePath),
    );
    const metadata = await lstat(tempDirectory);
    tempDirectoryDevice = metadata.dev;
    tempDirectoryInode = metadata.ino;
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
    if (isFileSystemError(error, "ENOENT")) {
      return {
        baseURL,
        tempDirectory,
        tempDirectoryDevice,
        tempDirectoryInode,
        storageStatePath,
      };
    }
    throw new Error("Preview storage state must be absent before authentication");
  }
  throw new Error("Preview storage state must be absent before authentication");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function assertCaptureDirectoryIdentity(input: {
  tempDirectory: string;
  tempDirectoryDevice: number;
  tempDirectoryInode: number;
}): Promise<void> {
  const candidate = assertProtectedTemporaryDirectory(input.tempDirectory);
  const metadata = await lstat(candidate);
  if (
    metadata.dev !== input.tempDirectoryDevice ||
    metadata.ino !== input.tempDirectoryInode
  ) {
    throw new Error("preview directory changed");
  }
}

async function assertOpenStorageStateIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  input: {
    tempDirectory: string;
    tempDirectoryDevice: number;
    tempDirectoryInode: number;
    storageStatePath: string;
  },
): Promise<void> {
  await assertCaptureDirectoryIdentity(input);
  const [descriptor, leaf] = await Promise.all([
    handle.stat(),
    lstat(input.storageStatePath),
  ]);
  if (
    !descriptor.isFile() ||
    descriptor.nlink !== 1 ||
    (descriptor.mode & 0o777) !== 0o600 ||
    leaf.isSymbolicLink() ||
    !leaf.isFile() ||
    leaf.nlink !== 1 ||
    (leaf.mode & 0o777) !== 0o600 ||
    leaf.dev !== descriptor.dev ||
    leaf.ino !== descriptor.ino
  ) {
    throw new Error("unsafe storage state");
  }
}

async function persistCapturedStorageState(
  state: unknown,
  input: {
    tempDirectory: string;
    tempDirectoryDevice: number;
    tempDirectoryInode: number;
    storageStatePath: string;
  },
): Promise<void> {
  let serializedState: string;
  try {
    const serialized = JSON.stringify(state);
    if (serialized === undefined) throw new Error("missing storage state");
    serializedState = serialized;
  } catch {
    throw new Error("Preview storage state was not captured securely");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let wroteState = false;
  try {
    await assertCaptureDirectoryIdentity(input);
    handle = await open(
      input.storageStatePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await assertOpenStorageStateIdentity(handle, input);
    await handle.writeFile(serializedState, { encoding: "utf8" });
    wroteState = true;
    await handle.sync();
    await assertOpenStorageStateIdentity(handle, input);
  } catch {
    if (wroteState && handle !== undefined) {
      try {
        await handle.truncate(0);
        await handle.sync();
      } catch {
        // Best-effort scrubbing still returns only the generic safe error.
      }
    }
    throw new Error("Preview storage state was not captured securely");
  } finally {
    await handle?.close();
  }
}

async function launchPreviewBrowser(
  browserDriver: PreviewChromium,
  signal: AbortSignal,
): Promise<PreviewBrowser> {
  if (signal.aborted) throw new Error("Preview harness terminated.");
  let rejectAbort: (error: Error) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortListener = () => {
    rejectAbort(new Error("Preview harness terminated."));
  };
  signal.addEventListener("abort", abortListener, { once: true });
  const launched = browserDriver.launch({ headless: false }).then(async (browser) => {
    if (signal.aborted) {
      await browser.close().catch(() => undefined);
      throw new Error("Preview harness terminated.");
    }
    return browser;
  });
  try {
    return await Promise.race([launched, aborted]);
  } finally {
    signal.removeEventListener("abort", abortListener);
  }
}

export async function capturePreviewAccessState(
  input: { baseURL: string; storageStatePath: string },
  browserDriver: PreviewChromium = chromium,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const captureInput = await resolveCaptureAccessStateInput(input);
  const { baseURL } = captureInput;
  const browser = await launchPreviewBrowser(browserDriver, signal);
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
            const storageState = await context.storageState();
            await persistCapturedStorageState(storageState, captureInput);
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
      if (code === 0) {
        if (stdout.length > 0) writeOutput(stdout.join(""), "stdout");
        if (stderr.length > 0) writeOutput(stderr.join(""), "stderr");
      } else {
        writeOutput("Preview checks failed; re-authenticate and retry.\n", "stderr");
      }
      resolve(code);
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
    createTempDirectory: createPreviewTempDirectory,
    removeTempDirectory: removePreviewTempDirectory,
    registerSignalCleanup: registerPreviewSignalCleanup,
    captureAccessState: (input, signal) =>
      capturePreviewAccessState(input, chromium, signal),
    runPreviewSuite,
  };
}
