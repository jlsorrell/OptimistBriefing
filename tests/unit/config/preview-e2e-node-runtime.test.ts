import { spawn as spawnChild } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { lstatSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_TEMP_PREFIX } from "../../../scripts/preview-e2e/environment";
import {
  authorizePreviewWithManagedOAuth,
  openPreviewAuthorizationURL,
} from "../../../scripts/preview-e2e/managed-oauth";
import {
  createNodePreviewHarnessDependencies,
  createPreviewSignalHandler,
  createPreviewTempDirectory,
  previewNpxExecutable,
  registerPreviewExitCleanup,
  removePreviewTempDirectory,
  removePreviewTempDirectorySync,
  runPreviewSuite,
} from "../../../scripts/preview-e2e/node-runtime";

vi.mock("../../../scripts/preview-e2e/managed-oauth", () => ({
  authorizePreviewWithManagedOAuth: vi.fn(),
  openPreviewAuthorizationURL: vi.fn(),
}));

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
  return {
    OPTIMIST_PREVIEW_BASE_URL: baseURL,
    OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
    OPTIMIST_PREVIEW_ACCESS_TOKEN: "synthetic-preview-token-1234",
  };
}

class FakePreviewChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn((_signal?: NodeJS.Signals) => true);
}

async function ownTemporaryDirectory(path: string) {
  const metadata = await lstat(path);
  return {
    path,
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
  };
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

  it("authorizes through Managed OAuth with the ordinary-browser launcher", async () => {
    const signal = new AbortController().signal;
    vi.mocked(authorizePreviewWithManagedOAuth).mockResolvedValue("synthetic-preview-token-1234");
    const dependencies = createNodePreviewHarnessDependencies();

    await expect(dependencies.authorizePreview({ baseURL }, signal)).resolves.toBe(
      "synthetic-preview-token-1234",
    );
    expect(authorizePreviewWithManagedOAuth).toHaveBeenCalledWith(
      { baseURL },
      {
        openAuthorizationURL: openPreviewAuthorizationURL,
        reportStage: expect.any(Function),
      },
      signal,
    );
  });

  it("writes only fixed Managed OAuth stage text to stdout", async () => {
    const secret = "url-state-code-verifier-token-cookie-body-secret-fixture";
    const writeOutput = vi.fn();
    vi.mocked(authorizePreviewWithManagedOAuth).mockImplementation(
      async (_input, oauthDependencies) => {
        oauthDependencies?.reportStage?.("client registration");
        throw new Error(secret);
      },
    );
    const dependencies = createNodePreviewHarnessDependencies({ writeOutput });

    await expect(dependencies.authorizePreview(
      { baseURL },
      new AbortController().signal,
    )).rejects.toThrow(secret);

    expect(writeOutput).toHaveBeenCalledExactlyOnceWith(
      "Preview authorization: client registration\n",
      "stdout",
    );
    expect(JSON.stringify(writeOutput.mock.calls)).not.toContain(secret);
  });

  it("removes only exact-prefix directories under the supplied temporary parent", async () => {
    const allowedDirectory = await createPreviewTempDirectory();
    temporaryParents.push(allowedDirectory);
    const ownership = await ownTemporaryDirectory(allowedDirectory);
    const unrelatedDirectory = await createTemporaryParent();

    await removePreviewTempDirectory(ownership);

    await expect(stat(allowedDirectory)).rejects.toThrow();
    await expect(removePreviewTempDirectory({
      ...ownership,
      path: unrelatedDirectory,
    })).rejects.toThrow(
      "Refusing unsafe preview cleanup target",
    );
    await expect(stat(unrelatedDirectory)).resolves.toBeDefined();
  });

  it("atomically quarantines and removes the captured directory identity", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    await writeFile(join(tempDirectory, "storage-state.json"), "{}", { mode: 0o600 });

    await removePreviewTempDirectory(ownership);

    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not delete a replacement present before asynchronous cleanup", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    const movedDirectory = `${tempDirectory}-owned`;
    temporaryParents.push(movedDirectory);
    await rename(tempDirectory, movedDirectory);
    await mkdir(tempDirectory, { mode: 0o700 });
    await writeFile(join(tempDirectory, "keep.txt"), "keep");
    let quarantineEntry = "";

    await expect(removePreviewTempDirectory(ownership, {
      beforeQuarantineRename: (_source, entry) => { quarantineEntry = entry; },
    })).rejects.toThrow("Refusing changed preview temporary directory");

    temporaryParents.push(dirname(quarantineEntry));
    await expect(stat(movedDirectory)).resolves.toBeDefined();
    await expect(readFile(join(quarantineEntry, "keep.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("does not delete a replacement introduced at the quarantine rename interleave", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    const movedDirectory = `${tempDirectory}-owned`;
    temporaryParents.push(movedDirectory);
    let quarantineEntry = "";

    await expect(removePreviewTempDirectory(ownership, {
      beforeQuarantineRename: async (source, entry) => {
        quarantineEntry = entry;
        await rename(source, movedDirectory);
        await mkdir(source, { mode: 0o700 });
        await writeFile(join(source, "keep.txt"), "keep");
      },
    })).rejects.toThrow("Refusing changed preview temporary directory");

    temporaryParents.push(dirname(quarantineEntry));
    await expect(stat(movedDirectory)).resolves.toBeDefined();
    await expect(readFile(join(quarantineEntry, "keep.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("uses the captured identity for synchronous quarantine cleanup", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    const movedDirectory = `${tempDirectory}-owned`;
    temporaryParents.push(movedDirectory);
    await rename(tempDirectory, movedDirectory);
    await mkdir(tempDirectory, { mode: 0o700 });
    await writeFile(join(tempDirectory, "keep.txt"), "keep");
    let quarantineEntry = "";

    expect(() => removePreviewTempDirectorySync(ownership, {
      beforeQuarantineRename: (_source, entry) => { quarantineEntry = entry; },
    })).toThrow("Refusing changed preview temporary directory");

    temporaryParents.push(dirname(quarantineEntry));
    await expect(stat(movedDirectory)).resolves.toBeDefined();
    await expect(readFile(join(quarantineEntry, "keep.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("lets synchronous fallback finish an async cleanup interrupted after quarantine", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    let quarantineRoot = "";

    await expect(removePreviewTempDirectory(ownership, {
      beforeQuarantineRename: (_source, entry) => {
        quarantineRoot = dirname(entry);
      },
      afterQuarantineRename: () => {
        throw new Error("process exit interrupted async cleanup");
      },
    })).rejects.toThrow("process exit interrupted async cleanup");

    removePreviewTempDirectorySync(ownership);

    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a replaced quarantine root and keeps its owned entry armed for fallback", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    await writeFile(join(tempDirectory, "keep.txt"), "keep", { mode: 0o600 });
    const processEvents = new EventEmitter();
    registerPreviewExitCleanup(ownership, processEvents);
    let quarantineRoot = "";
    let movedQuarantineRoot = "";

    await expect(removePreviewTempDirectory(ownership, {
      afterQuarantineRename: async (_source, entry) => {
        quarantineRoot = dirname(entry);
        movedQuarantineRoot = `${quarantineRoot}-moved`;
        temporaryParents.push(quarantineRoot, movedQuarantineRoot);
        await rename(quarantineRoot, movedQuarantineRoot);
        await symlink(movedQuarantineRoot, quarantineRoot);
      },
    })).rejects.toThrow("Refusing changed preview quarantine root");

    expect((await lstat(quarantineRoot)).isSymbolicLink()).toBe(true);
    await expect(readFile(join(movedQuarantineRoot, "owned", "keep.txt"), "utf8"))
      .resolves.toBe("keep");
    expect(processEvents.listenerCount("exit")).toBe(1);
    processEvents.emit("exit");
    expect(processEvents.listenerCount("exit")).toBe(1);
    expect(() => removePreviewTempDirectorySync(ownership))
      .toThrow("Refusing changed preview quarantine root");
    await expect(readFile(join(movedQuarantineRoot, "owned", "keep.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("removes only the verified owned entry and leaves an unvalidated sibling quarantined", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    await writeFile(join(tempDirectory, "storage-state.json"), "{}", { mode: 0o600 });
    let quarantineRoot = "";
    let quarantineEntry = "";
    let sibling = "";

    await expect(removePreviewTempDirectory(ownership, {
      afterQuarantineRename: async (_source, entry) => {
        quarantineEntry = entry;
        quarantineRoot = dirname(entry);
        sibling = join(quarantineRoot, "unvalidated-sibling.txt");
        temporaryParents.push(quarantineRoot);
        await writeFile(sibling, "leave me alone", { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: "ENOTEMPTY" });

    await expect(stat(quarantineEntry)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sibling, "utf8")).resolves.toBe("leave me alone");
    expect(() => removePreviewTempDirectorySync(ownership)).toThrow();
    await expect(readFile(sibling, "utf8")).resolves.toBe("leave me alone");
  });

  it("normalizes synchronous quarantine permissions under a restrictive umask", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const ownership = await ownTemporaryDirectory(tempDirectory);
    const previousUmask = process.umask(0o777);
    let quarantineRoot = "";
    let observedMode = -1;

    try {
      removePreviewTempDirectorySync(ownership, {
        beforeQuarantineRename: (_source, entry) => {
          quarantineRoot = dirname(entry);
          temporaryParents.push(quarantineRoot);
          observedMode = lstatSync(quarantineRoot).mode & 0o777;
        },
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(observedMode).toBe(0o700);
    await expect(stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers a synchronous exit cleanup for the exact protected directory", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    await writeFile(join(tempDirectory, "storage-state.json"), "{}", { mode: 0o600 });
    const processEvents = new EventEmitter();
    const ownership = await ownTemporaryDirectory(tempDirectory);

    registerPreviewExitCleanup(ownership, processEvents);
    processEvents.emit("exit");
    processEvents.emit("exit");

    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unregisters synchronous exit cleanup after successful asynchronous cleanup", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const processEvents = new EventEmitter();
    const ownership = await ownTemporaryDirectory(tempDirectory);
    const unregister = registerPreviewExitCleanup(ownership, processEvents);

    unregister();
    processEvents.emit("exit");

    await expect(stat(tempDirectory)).resolves.toBeDefined();
  });

  it("runs synchronous exit cleanup while signal shutdown is still pending", async () => {
    const tempDirectory = await createPreviewTempDirectory();
    temporaryParents.push(tempDirectory);
    const processEvents = new EventEmitter();
    const ownership = await ownTemporaryDirectory(tempDirectory);
    registerPreviewExitCleanup(ownership, processEvents);
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
    const ownership = await ownTemporaryDirectory(tempDirectory);
    let quarantineEntry = "";
    registerPreviewExitCleanup(ownership, processEvents, {
      beforeQuarantineRename: (_source, entry) => { quarantineEntry = entry; },
    });
    await rename(tempDirectory, movedDirectory);
    await mkdir(tempDirectory, { mode: 0o700 });
    await writeFile(join(tempDirectory, "keep.txt"), "keep");

    processEvents.emit("exit");

    temporaryParents.push(dirname(quarantineEntry));
    await expect(stat(movedDirectory)).resolves.toBeDefined();
    await expect(readFile(join(quarantineEntry, "keep.txt"), "utf8"))
      .resolves.toBe("keep");
  });

  it("rejects a symlinked cleanup directory without touching its target", async () => {
    const targetDirectory = await createTemporaryParent();
    const linkedDirectory = join(tmpdir(), `${PREVIEW_TEMP_PREFIX}cleanup-link-${Date.now()}`);
    temporaryParents.push(linkedDirectory);
    await writeFile(join(targetDirectory, "keep.txt"), "keep");
    await symlink(targetDirectory, linkedDirectory);
    let quarantineEntry = "";

    expect(() => removePreviewTempDirectorySync({
      path: linkedDirectory,
      device: 0,
      inode: 0,
      mode: 0o40700,
    }, {
      beforeQuarantineRename: (_source, entry) => { quarantineEntry = entry; },
    })).toThrow("Refusing changed preview temporary directory");
    temporaryParents.push(dirname(quarantineEntry));
    await expect(readFile(join(targetDirectory, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("rejects cleanup roots outside the operating-system temp directory", async () => {
    const untrustedParent = await mkdtemp(join(process.cwd(), "preview-untrusted-root-"));
    temporaryParents.push(untrustedParent);
    const directory = await mkdtemp(join(untrustedParent, PREVIEW_TEMP_PREFIX));
    await chmod(directory, 0o700);
    await writeFile(join(directory, "keep.txt"), "keep");

    const removeWithUnexpectedRoot = removePreviewTempDirectory as unknown as (
      ownership: Awaited<ReturnType<typeof ownTemporaryDirectory>>,
      temporaryRoot: string,
    ) => Promise<void>;
    const ownership = await ownTemporaryDirectory(directory);

    await expect(removeWithUnexpectedRoot(ownership, untrustedParent)).rejects.toThrow(
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

  it("runs the synchronous fallback before relaying a failed shutdown", async () => {
    const order: string[] = [];
    const handler = createPreviewSignalHandler(
      async () => {
        order.push("shutdown");
        throw new Error("cleanup failed");
      },
      () => { order.push("unregister"); },
      (signal) => { order.push(`relay:${signal}`); },
      () => { order.push("fallback"); },
    );

    await expect(handler("SIGTERM")).rejects.toThrow("cleanup failed");
    expect(order).toEqual([
      "shutdown",
      "fallback",
      "unregister",
      "relay:SIGTERM",
    ]);
  });

  it("still unregisters and relays when the synchronous fallback refuses cleanup", async () => {
    const order: string[] = [];
    const handler = createPreviewSignalHandler(
      async () => {
        order.push("shutdown");
        throw new Error("async cleanup failed");
      },
      () => { order.push("unregister"); },
      (signal) => { order.push(`relay:${signal}`); },
      () => {
        order.push("fallback");
        throw new Error("changed identity");
      },
    );

    await expect(handler("SIGINT")).rejects.toThrow("async cleanup failed");
    expect(order).toEqual([
      "shutdown",
      "fallback",
      "unregister",
      "relay:SIGINT",
    ]);
  });

  it("runs the fallback in a real child before default SIGTERM termination", async () => {
    const parent = await createTemporaryParent();
    const markerPath = join(parent, "fallback-ran");
    const moduleURL = pathToFileURL(resolve(
      import.meta.dirname,
      "../../../scripts/preview-e2e/node-runtime.ts",
    )).href;
    const script = `
      import { writeFileSync } from "node:fs";
      const { createPreviewSignalHandler } = await import(${JSON.stringify(moduleURL)});
      let handler;
      const listener = () => { void handler("SIGTERM").catch(() => undefined); };
      const unregister = () => process.off("SIGTERM", listener);
      handler = createPreviewSignalHandler(
        async () => { throw new Error("cleanup failed"); },
        unregister,
        (signal) => process.kill(process.pid, signal),
        () => writeFileSync(${JSON.stringify(markerPath)}, "fallback", { mode: 0o600 }),
      );
      process.on("SIGTERM", listener);
      process.stdout.write("ready\\n");
      setInterval(() => undefined, 1_000);
    `;
    const child = spawnChild(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const [ready] = await once(child.stdout!, "data");
    expect(String(ready)).toContain("ready");

    child.kill("SIGTERM");
    const [code, signal] = await once(child, "close");

    expect(code).toBeNull();
    expect(signal).toBe("SIGTERM");
    await expect(readFile(markerPath, "utf8")).resolves.toBe("fallback");
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

  it("prints only validated safe reporter lines before the generic failure", async () => {
    const env = await createProtectedSuiteEnvironment();
    const child = new FakePreviewChild();
    const writeOutput = vi.fn();
    const running = runPreviewSuite(env, new AbortController().signal, {
      platform: "linux",
      spawnProcess: vi.fn(() => child) as never,
      writeOutput,
    });
    const safeLine =
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/content.spec.ts line=18 errorLine=44 status=timedOut";

    child.stdout.write([
      "test title access-token-fixture",
      safeLine,
      `${safeLine} access-token-fixture`,
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/content.spec.ts line=18 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/content.spec.ts line=18 errorLine=66 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/content.spec.ts line=18 errorLine=1234567890123456 status=failed",
      "OPTIMIST_PREVIEW_TEST_RESULT project=tablet file=tests/preview-e2e/../secret.ts line=18 errorLine=0 status=failed",
    ].join("\n"));
    child.stderr.write("Error: https://preview.example/?token=access-token-fixture\n");
    child.emit("close", 3, null);

    await expect(running).resolves.toBe(3);
    expect(writeOutput.mock.calls).toEqual([
      [`${safeLine}\n`, "stderr"],
      ["Preview checks failed; re-authenticate and retry.\n", "stderr"],
    ]);
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("access-token-fixture");
    expect(writeOutput.mock.calls.flat().join(" ")).not.toContain("https://");
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
    env.OPTIMIST_PREVIEW_ACCESS_TOKEN = "invalid token";
    const spawnProcess = vi.fn();

    await expect(runPreviewSuite(env, new AbortController().signal, {
      spawnProcess: spawnProcess as never,
    })).rejects.toThrow("Preview access token is invalid");
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
