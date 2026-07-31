import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import {
  PREVIEW_TEMP_PREFIX,
  assertAuthenticationNavigation,
  assertTemporaryDirectory,
  normalizeChildExitCode,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
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
  await rm(assertTemporaryDirectory(tempDirectory, systemTempDirectory), {
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
  const storageStatePath = resolve(input.storageStatePath);
  let tempDirectory: string;
  try {
    tempDirectory = assertTemporaryDirectory(dirname(storageStatePath));
    const [metadata, realTempDirectory, realSystemTempDirectory] = await Promise.all([
      lstat(tempDirectory),
      realpath(tempDirectory),
      realpath(tmpdir()),
    ]);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700 ||
      dirname(realTempDirectory) !== realSystemTempDirectory
    ) {
      throw new Error("Unsafe preview storage directory");
    }
  } catch {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  if (storageStatePath !== join(tempDirectory, "storage-state.json")) {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  return { baseURL, storageStatePath };
}

export async function capturePreviewAccessState(
  input: { baseURL: string; storageStatePath: string },
  browserDriver: PreviewChromium = chromium,
): Promise<void> {
  const { baseURL, storageStatePath } = await resolveCaptureAccessStateInput(input);
  const browser = await browserDriver.launch({ headless: false });
  try {
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
          await chmod(storageStatePath, 0o600);
        })(),
      ]);
    } catch (error) {
      if (isPlaywrightNavigationError(error)) {
        throw new Error("Preview authentication did not complete; retry the command.");
      }
      throw error;
    } finally {
      page.off("framenavigated", navigationListener);
    }
  } finally {
    await browser.close();
  }
}

export function createPreviewSignalHandler(
  signal: NodeJS.Signals,
  cleanup: () => Promise<void>,
  relaySignal: (signal: NodeJS.Signals) => void,
): () => Promise<void> {
  return async () => {
    try {
      await cleanup();
    } finally {
      relaySignal(signal);
    }
  };
}

export function registerPreviewSignalCleanup(
  cleanup: () => Promise<void>,
): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = createPreviewSignalHandler(signal, cleanup, (value) => {
      process.kill(process.pid, value);
    });
    const listener = () => { void handler(); };
    handlers.set(signal, listener);
    process.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of handlers) process.off(signal, listener);
  };
}

export async function runPreviewSuite(env: NodeJS.ProcessEnv): Promise<number> {
  resolvePreviewRuntimeEnvironment(env);
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["playwright", "test", "--config", "playwright.preview.config.ts"],
      { env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(normalizeChildExitCode(code, signal)));
  });
}

export function createNodePreviewHarnessDependencies(): PreviewHarnessDependencies {
  return {
    createTempDirectory: createPreviewTempDirectory,
    removeTempDirectory: removePreviewTempDirectory,
    registerSignalCleanup: registerPreviewSignalCleanup,
    captureAccessState: capturePreviewAccessState,
    runPreviewSuite,
  };
}
