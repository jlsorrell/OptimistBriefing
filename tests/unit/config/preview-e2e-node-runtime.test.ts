import { EventEmitter } from "node:events";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_TEMP_PREFIX } from "../../../scripts/preview-e2e/environment";
import {
  capturePreviewAccessState,
  createPreviewSignalHandler,
  createPreviewTempDirectory,
  previewNpxExecutable,
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
  kill = vi.fn(() => true);
}

afterEach(async () => {
  await Promise.all(temporaryParents.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("preview E2E Node runtime", () => {
  it("creates the authentication directory with mode 0700", async () => {
    const parent = await createTemporaryParent();

    const directory = await createPreviewTempDirectory(parent);

    expect(directory).toMatch(new RegExp(`${PREVIEW_TEMP_PREFIX}.+`));
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
      storageState: vi.fn(async ({ path }: { path: string }) => {
        await writeFile(path, "{}", { mode: 0o666 });
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
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    await expect(readFile(storageStatePath, "utf8")).resolves.toBe("{}");
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
      storageState: vi.fn(async ({ path }: { path: string }) => {
        await writeFile(path, "{}", { mode: 0o600 });
      }),
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

  it("rejects a symlink created in place of captured storage state", async () => {
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
      storageState: vi.fn(async ({ path }: { path: string }) => {
        await symlink(symlinkTarget, path);
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

  it("removes only exact-prefix directories under the supplied temporary parent", async () => {
    const parent = await createTemporaryParent();
    const allowedDirectory = join(parent, `${PREVIEW_TEMP_PREFIX}cleanup`);
    const unrelatedDirectory = join(parent, "unrelated");
    await mkdir(allowedDirectory, { mode: 0o700 });
    await mkdir(unrelatedDirectory);

    await removePreviewTempDirectory(allowedDirectory, parent);

    await expect(stat(allowedDirectory)).rejects.toThrow();
    await expect(removePreviewTempDirectory(unrelatedDirectory, parent)).rejects.toThrow(
      "Refusing unsafe preview cleanup target",
    );
    await expect(stat(unrelatedDirectory)).resolves.toBeDefined();
  });

  it("rejects a symlinked cleanup directory without touching its target", async () => {
    const parent = await createTemporaryParent();
    const targetDirectory = join(parent, "cleanup-target");
    const linkedDirectory = join(parent, `${PREVIEW_TEMP_PREFIX}cleanup-link`);
    await mkdir(targetDirectory, { mode: 0o700 });
    await writeFile(join(targetDirectory, "keep.txt"), "keep");
    await symlink(targetDirectory, linkedDirectory);

    await expect(removePreviewTempDirectory(linkedDirectory, parent)).rejects.toThrow(
      "Refusing unsafe preview temporary directory",
    );
    await expect(readFile(join(targetDirectory, "keep.txt"), "utf8")).resolves.toBe("keep");
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

    await expect(running).resolves.toBe(4);
    expect(writeOutput).toHaveBeenCalledTimes(1);
    expect(writeOutput).toHaveBeenCalledWith(
      "Preview checks failed; re-authenticate and retry.\n",
      "stderr",
    );
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("sensitive");
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("Sign in with Google");
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
