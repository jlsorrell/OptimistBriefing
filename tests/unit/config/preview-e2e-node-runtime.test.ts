import { EventEmitter } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_TEMP_PREFIX } from "../../../scripts/preview-e2e/environment";
import {
  capturePreviewAccessState,
  createPreviewSignalHandler,
  createPreviewTempDirectory,
  previewNpxExecutable,
  registerPreviewExitCleanup,
  removePreviewTempDirectory,
  runPreviewSuite,
} from "../../../scripts/preview-e2e/node-runtime";

const baseURL = "https://optimist-briefing-preview.optimistindustries.workers.dev";
const temporaryParents: string[] = [];

async function createTemporaryParent(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "preview-e2e-node-runtime-test-"));
  temporaryParents.push(path);
  return path;
}

async function createProtectedSuiteEnvironment(): Promise<NodeJS.ProcessEnv> {
  const tempDirectory = await createPreviewTempDirectory();
  temporaryParents.push(tempDirectory);
  const storageStatePath = join(tempDirectory, "storage-state.json");
  await writeFile(storageStatePath, "{}", { mode: 0o600 });
  await chmod(storageStatePath, 0o600);
  return {
    OPTIMIST_PREVIEW_BASE_URL: baseURL,
    OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
    OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
  };
}

class FakePreviewChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryParents.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("preview E2E Node runtime", () => {
  it("creates the authentication directory with mode 0700", async () => {
    const directory = await createPreviewTempDirectory();
    temporaryParents.push(directory);

    expect(directory).toMatch(new RegExp(`${PREVIEW_TEMP_PREFIX}.+`));
    expect(dirname(await realpath(directory))).toBe(await realpath(tmpdir()));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("writes protected storage state with mode 0600", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockResolvedValue(null),
      waitForURL: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(null),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn().mockResolvedValue({}),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const launch = vi.fn().mockResolvedValue(browser);

    await capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch },
    );

    expect(launch).toHaveBeenCalledWith({
      channel: "chrome",
      headless: false,
      timeout: 15_000,
    });
    const metadata = await lstat(storageStatePath);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    await expect(readFile(storageStatePath, "utf8")).resolves.toBe("{}");
  });

  it("captures state in memory before creating a single-link protected leaf", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const outsideDirectory = await createTemporaryParent();
    const outsideLink = join(outsideDirectory, "leaked-state.json");
    const capturedState = { cookies: [], origins: [] };
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockResolvedValue(null),
      waitForURL: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(null),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(async (options?: { path: string }) => {
        if (options !== undefined) {
          await writeFile(options.path, JSON.stringify(capturedState), { mode: 0o600 });
          await link(options.path, outsideLink);
        }
        return capturedState;
      }),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch: vi.fn().mockResolvedValue(browser) },
    );

    const metadata = await lstat(storageStatePath);
    expect(metadata.nlink).toBe(1);
    await expect(stat(outsideLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(storageStatePath, "utf8")).resolves.toBe(
      JSON.stringify(capturedState),
    );
  });

  it("does not write state after the protected parent is replaced", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const movedDirectory = `${tempDirectory}-moved`;
    const replacementDirectory = await createTemporaryParent();
    temporaryParents.push(movedDirectory);
    const capturedState = { cookies: [], origins: [] };
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockResolvedValue(null),
      waitForURL: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(null),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(async (options?: { path: string }) => {
        await rename(tempDirectory, movedDirectory);
        await symlink(replacementDirectory, tempDirectory);
        if (options !== undefined) {
          await writeFile(options.path, JSON.stringify(capturedState), { mode: 0o600 });
        }
        return capturedState;
      }),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch: vi.fn().mockResolvedValue(browser) },
    )).rejects.toThrow("Preview storage state was not captured securely");
    await expect(stat(join(replacementDirectory, "storage-state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects every preexisting storage-state leaf before launching Chromium", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockResolvedValue(null),
      waitForURL: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(null),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn().mockResolvedValue({}),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);

    await writeFile(storageStatePath, "preexisting", { mode: 0o600 });
    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch },
    )).rejects.toThrow("Preview storage state must be absent before authentication");

    await rm(storageStatePath);
    const symlinkTarget = join(tempDirectory, "symlink-target.json");
    await writeFile(symlinkTarget, "target", { mode: 0o600 });
    await symlink(symlinkTarget, storageStatePath);
    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch },
    )).rejects.toThrow("Preview storage state must be absent before authentication");

    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a symlink created before the atomic storage-state leaf", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const symlinkTarget = join(tempDirectory, "captured-target.json");
    await writeFile(symlinkTarget, "{}", { mode: 0o600 });
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockResolvedValue(null),
      waitForURL: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(null),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(async () => {
        await symlink(symlinkTarget, storageStatePath);
        return {};
      }),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch: vi.fn().mockResolvedValue(browser) },
    )).rejects.toThrow("Preview storage state was not captured securely");
  });

  it("rejects direct callers' unsafe origin and storage path before launching Chromium", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const launch = vi.fn();

    await expect(capturePreviewAccessState(
      {
        baseURL: "https://example.com/current-login",
        storageStatePath: join(tempDirectory, "storage-state.json"),
      },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview E2E may only target the isolated preview origin",
    });
    await expect(capturePreviewAccessState(
      {
        baseURL,
        storageStatePath: join(tempDirectory, "other-state.json"),
      },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview storage state must be the protected temporary file",
    });

    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a prefix-named temporary-directory symlink before launching Chromium", async () => {
    const targetDirectory = await mkdtemp(join(process.cwd(), "preview-e2e-node-runtime-target-"));
    const linkedDirectory = join(tmpdir(), `${PREVIEW_TEMP_PREFIX}symlink-${Date.now()}`);
    temporaryParents.push(linkedDirectory, targetDirectory);
    await symlink(targetDirectory, linkedDirectory);
    const launch = vi.fn();

    await expect(capturePreviewAccessState(
      {
        baseURL,
        storageStatePath: join(linkedDirectory, "storage-state.json"),
      },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview storage state must be the protected temporary file",
    });

    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a direct temporary-directory child whose mode is not 0700 before launching Chromium", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), PREVIEW_TEMP_PREFIX));
    temporaryParents.push(tempDirectory);
    await chmod(tempDirectory, 0o755);
    const launch = vi.fn();

    await expect(capturePreviewAccessState(
      {
        baseURL,
        storageStatePath: join(tempDirectory, "storage-state.json"),
      },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview storage state must be the protected temporary file",
    });

    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects unexpected main-frame navigation without exposing its URL and detaches the listener", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const unexpectedFrame = { url: () => "https://example.com/current-login" };
    let navigationListener: ((frame: { url(): string }) => void) | undefined;
    const page = {
      on: vi.fn((_event, listener) => { navigationListener = listener; }),
      off: vi.fn(),
      mainFrame: vi.fn(() => unexpectedFrame),
      goto: vi.fn(async () => { navigationListener!(unexpectedFrame); }),
      waitForURL: vi.fn(),
      waitForFunction: vi.fn(),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath: join(tempDirectory, "storage-state.json") },
      { launch: vi.fn().mockResolvedValue(browser) },
    )).rejects.toMatchObject({ message: "Authentication left the approved origins" });

    expect(page.off).toHaveBeenCalledWith("framenavigated", navigationListener);
  });

  it("redacts Playwright navigation failures to a generic retry error", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn().mockRejectedValue(new Error(`${baseURL}/current-login timed out`)),
      waitForURL: vi.fn(),
      waitForFunction: vi.fn(),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath: join(tempDirectory, "storage-state.json") },
      { launch: vi.fn().mockResolvedValue(browser) },
    )).rejects.toMatchObject({
      message: "Preview authentication did not complete; retry the command.",
    });
  });

  it("redacts a missing stable Chrome channel failure", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const launch = vi.fn().mockRejectedValue(new Error(
      "Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app",
    ));

    await expect(capturePreviewAccessState(
      { baseURL, storageStatePath: join(tempDirectory, "storage-state.json") },
      { launch },
    )).rejects.toMatchObject({
      message: "Preview authentication browser could not start; install stable Google Chrome and retry.",
    });
    expect(launch).toHaveBeenCalledWith({
      channel: "chrome",
      headless: false,
      timeout: 15_000,
    });
  });

  it("closes and awaits the authentication browser when aborted", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const abortController = new AbortController();
    let rejectNavigation: ((error: Error) => void) | undefined;
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const frame = {};
    const page = {
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: vi.fn(() => frame),
      goto: vi.fn(() => new Promise((_resolve, reject) => { rejectNavigation = reject; })),
      waitForURL: vi.fn(),
      waitForFunction: vi.fn(),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn(),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn(async () => {
        await closeGate;
        rejectNavigation!(new Error("browser closed"));
      }),
    };

    const capture = capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch: vi.fn().mockResolvedValue(browser) },
      abortController.signal,
    );
    await vi.waitFor(() => expect(page.goto).toHaveBeenCalledOnce());
    abortController.abort("SIGTERM");
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalledOnce());
    let settled = false;
    void capture.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseClose!();

    await expect(capture).rejects.toThrow("Preview harness terminated");
  });

  it("keeps cleanup and signal relay behind bounded pending-launch termination", async () => {
    vi.useFakeTimers();
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const abortController = new AbortController();
    let markLaunchStarted: (() => void) | undefined;
    const launchStarted = new Promise<void>((resolve) => { markLaunchStarted = resolve; });
    let launchTerminated = false;
    const launch = vi.fn((options: { headless: boolean; timeout?: number }) => {
      markLaunchStarted!();
      return new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          launchTerminated = true;
          reject(new Error("browser launch terminated"));
        }, options.timeout ?? 0);
      });
    });
    const capture = capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch },
      abortController.signal,
    );
    const order: string[] = [];
    const handler = createPreviewSignalHandler(
      async (signal) => {
        abortController.abort(signal);
        await capture.catch(() => undefined);
        order.push("cleanup");
      },
      () => { order.push("unregister"); },
      (signal) => { order.push(`relay:${signal}`); },
    );
    await launchStarted;

    const signalHandling = handler("SIGTERM");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(launchTerminated).toBe(false);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(signalHandling).resolves.toBeUndefined();
    expect(launch).toHaveBeenCalledWith({
      channel: "chrome",
      headless: false,
      timeout: 15_000,
    });
    expect(launchTerminated).toBe(true);
    expect(order).toEqual(["cleanup", "unregister", "relay:SIGTERM"]);
  });

  it("awaits closure of a browser returned after launch abort", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const storageStatePath = join(tempDirectory, "storage-state.json");
    const abortController = new AbortController();
    const newContext = vi.fn().mockRejectedValue(new Error("browser closed"));
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => { await closeGate; });
    const lateBrowser = { newContext, close };
    let resolveLaunch: ((browser: typeof lateBrowser) => void) | undefined;
    let markLaunchStarted: (() => void) | undefined;
    const launchStarted = new Promise<void>((resolve) => { markLaunchStarted = resolve; });
    const launch = vi.fn(() => {
      markLaunchStarted!();
      return new Promise<typeof lateBrowser>((resolve) => { resolveLaunch = resolve; });
    });
    const outcome = capturePreviewAccessState(
      { baseURL, storageStatePath },
      { launch },
      abortController.signal,
    ).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await launchStarted;
    abortController.abort("SIGTERM");
    const settledBeforeLateResolution = await Promise.race([
      outcome.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    resolveLaunch!(lateBrowser);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    const settledBeforeClose = await Promise.race([
      outcome.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    releaseClose!();

    await expect(outcome).resolves.toBe("rejected");
    expect(settledBeforeLateResolution).toBe(false);
    expect(settledBeforeClose).toBe(false);
    expect(newContext).not.toHaveBeenCalled();
  });

  it("removes only exact-prefix directories under the supplied temporary parent", async () => {
    const allowedDirectory = await createPreviewTempDirectory();
    temporaryParents.push(allowedDirectory);
    const unrelatedDirectory = await createTemporaryParent();

    await removePreviewTempDirectory(allowedDirectory);

    await expect(stat(allowedDirectory)).rejects.toThrow();
    await expect(removePreviewTempDirectory(unrelatedDirectory)).rejects.toThrow(
      "Refusing unsafe preview cleanup target",
    );
    await expect(stat(unrelatedDirectory)).resolves.toBeDefined();
  });

  it("registers a synchronous exit cleanup for the exact protected directory", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    await writeFile(join(tempDirectory, "storage-state.json"), "{}", { mode: 0o600 });
    const processEvents = new EventEmitter();

    registerPreviewExitCleanup(tempDirectory, processEvents);
    processEvents.emit("exit");
    processEvents.emit("exit");

    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unregisters synchronous exit cleanup after successful asynchronous cleanup", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const processEvents = new EventEmitter();
    const unregister = registerPreviewExitCleanup(tempDirectory, processEvents);

    unregister();
    processEvents.emit("exit");

    await expect(stat(tempDirectory)).resolves.toBeDefined();
  });

  it("runs synchronous exit cleanup while signal shutdown is still pending", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const processEvents = new EventEmitter();
    registerPreviewExitCleanup(tempDirectory, processEvents);
    let finishShutdown: (() => void) | undefined;
    const shutdownGate = new Promise<void>((resolve) => { finishShutdown = resolve; });
    const handler = createPreviewSignalHandler(
      async () => { await shutdownGate; },
      vi.fn(),
      vi.fn(),
    );

    const signalHandling = handler("SIGINT");
    processEvents.emit("exit");

    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    finishShutdown!();
    await expect(signalHandling).resolves.toBeUndefined();
  });

  it("refuses synchronous exit cleanup after the owned path is replaced", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const movedDirectory = `${tempDirectory}-owned`;
    temporaryParents.push(movedDirectory);
    const processEvents = new EventEmitter();
    registerPreviewExitCleanup(tempDirectory, processEvents);
    await rename(tempDirectory, movedDirectory);
    await mkdir(tempDirectory, { mode: 0o700 });
    await writeFile(join(tempDirectory, "keep.txt"), "keep");

    processEvents.emit("exit");

    await expect(stat(movedDirectory)).resolves.toBeDefined();
    await expect(readFile(join(tempDirectory, "keep.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("rejects a symlinked cleanup directory without touching its target", async () => {
    const targetDirectory = await createTemporaryParent();
    const linkedDirectory = join(tmpdir(), `${PREVIEW_TEMP_PREFIX}cleanup-link-${Date.now()}`);
    temporaryParents.push(linkedDirectory);
    await writeFile(join(targetDirectory, "keep.txt"), "keep");
    await symlink(targetDirectory, linkedDirectory);

    await expect(removePreviewTempDirectory(linkedDirectory)).rejects.toThrow(
      "Refusing unsafe preview temporary directory",
    );
    await expect(readFile(join(targetDirectory, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("rejects cleanup roots outside the operating-system temp directory", async () => {
    const untrustedParent = await mkdtemp(join(process.cwd(), "preview-untrusted-root-"));
    temporaryParents.push(untrustedParent);
    const directory = await mkdtemp(join(untrustedParent, PREVIEW_TEMP_PREFIX));
    await chmod(directory, 0o700);
    await writeFile(join(directory, "keep.txt"), "keep");

    const removeWithUnexpectedRoot = removePreviewTempDirectory as unknown as (
      path: string,
      temporaryRoot: string,
    ) => Promise<void>;

    await expect(removeWithUnexpectedRoot(directory, untrustedParent)).rejects.toThrow(
      "Refusing unsafe preview cleanup target",
    );
    await expect(readFile(join(directory, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("uses the first concurrent signal and relays only after shutdown", async () => {
    const order: string[] = [];
    const handler = createPreviewSignalHandler(
      async (signal) => { order.push(`shutdown:${signal}`); },
      () => { order.push("unregister"); },
      (signal) => { order.push(`relay:${signal}`); },
    );

    await Promise.all([handler("SIGTERM"), handler("SIGINT")]);

    expect(order).toEqual([
      "shutdown:SIGTERM",
      "unregister",
      "relay:SIGTERM",
    ]);
  });

  it("uses the platform-aware npx launcher", () => {
    expect(previewNpxExecutable("win32")).toBe("npx.cmd");
    expect(previewNpxExecutable("darwin")).toBe("npx");
    expect(previewNpxExecutable("linux")).toBe("npx");
  });

  it("terminates and awaits the preview child before a signal run settles", async () => {
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    const abortController = new AbortController();
    const writeOutput = vi.fn();
    const running = runPreviewSuite(env, abortController.signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput,
    });

    abortController.abort("SIGTERM");
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    let settled = false;
    void running.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(running).resolves.toBe(1);
    expect(writeOutput).toHaveBeenCalledWith(
      "Preview checks failed; re-authenticate and retry.\n",
      "stderr",
    );
  });

  it("treats an aborted child close with code zero as a redacted failure", async () => {
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    const abortController = new AbortController();
    const writeOutput = vi.fn();
    const running = runPreviewSuite(env, abortController.signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput,
    });
    child.stdout.write("sensitive successful output\n");

    abortController.abort("SIGTERM");
    child.emit("close", 0, null);

    await expect(running).resolves.toBe(1);
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(writeOutput).toHaveBeenCalledWith(
      "Preview checks failed; re-authenticate and retry.\n",
      "stderr",
    );
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("sensitive");
  });

  it("does not leave a grace timer when the initial kill closes synchronously", async () => {
    vi.useFakeTimers();
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") child.emit("close", 1, null);
      return true;
    });
    const abortController = new AbortController();
    const running = runPreviewSuite(env, abortController.signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput: vi.fn(),
      terminationGraceMilliseconds: 5,
      terminationFallbackMilliseconds: 5,
    });

    abortController.abort("SIGTERM");
    await expect(running).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates an unresponsive child and settles after a bounded fallback", async () => {
    vi.useFakeTimers();
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    const abortController = new AbortController();
    const writeOutput = vi.fn();
    const running = runPreviewSuite(env, abortController.signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput,
      terminationGraceMilliseconds: 5,
      terminationFallbackMilliseconds: 5,
    });

    abortController.abort("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(5);

    await expect(running).resolves.toBe(1);
    expect(writeOutput).toHaveBeenCalledWith(
      "Preview checks failed; re-authenticate and retry.\n",
      "stderr",
    );
  });

  it("suppresses failed preview output and preserves the numeric exit code", async () => {
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    const writeOutput = vi.fn();
    const running = runPreviewSuite(env, new AbortController().signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput,
    });

    child.stdout.write("https://accounts.google.com/login?state=sensitive\n");
    child.stderr.write("<body>Sign in with Google secret page</body>\n");
    child.emit("exit", 4, null);
    child.emit("close", 4, null);

    await expect(running).resolves.toBe(4);
    expect(writeOutput).toHaveBeenCalledTimes(1);
    expect(writeOutput).toHaveBeenCalledWith(
      "Preview checks failed; re-authenticate and retry.\n",
      "stderr",
    );
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("sensitive");
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("Sign in with Google");
  });

  it("flushes successful output only after close drains late pipe chunks", async () => {
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    const writeOutput = vi.fn();
    const running = runPreviewSuite(env, new AbortController().signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput,
    });

    child.stdout.write("before-exit\n");
    child.emit("exit", 0, null);
    child.stdout.write("after-exit\n");
    child.emit("close", 0, null);

    await expect(running).resolves.toBe(0);
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(writeOutput).toHaveBeenCalledWith(
      "before-exit\nafter-exit\n",
      "stdout",
    );
  });

  it("rejects an unprotected suite state before spawning Playwright", async () => {
    const env = await createProtectedSuiteEnvironment();
    await chmod(env.OPTIMIST_PREVIEW_STORAGE_STATE!, 0o644);
    const spawnProcess = vi.fn();

    await expect(runPreviewSuite(env, new AbortController().signal, {
      spawnProcess: spawnProcess as never,
    })).rejects.toThrow("Preview storage state must be the protected temporary file");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
