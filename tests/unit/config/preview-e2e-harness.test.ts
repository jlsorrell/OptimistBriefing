import { describe, expect, it, vi } from "vitest";

import {
  runPreviewHarness,
  type PreviewHarnessDependencies,
} from "../../../scripts/preview-e2e/harness";

const tempDirectory = "/tmp/optimist-preview-e2e-unit";
const ownedTempDirectory = {
  path: tempDirectory,
  device: 1,
  inode: 2,
  mode: 0o40700,
};
const baseURL = "https://optimist-briefing-preview.optimistindustries.workers.dev";
const accessToken = "synthetic-preview-token-1234";

function createDependencies(
): PreviewHarnessDependencies & {
  createTempDirectory: ReturnType<typeof vi.fn>;
  removeTempDirectory: ReturnType<typeof vi.fn>;
  removeTempDirectorySync: ReturnType<typeof vi.fn>;
  registerExitCleanup: ReturnType<typeof vi.fn>;
  registerSignalCleanup: ReturnType<typeof vi.fn>;
  authorizePreview: ReturnType<typeof vi.fn>;
  runPreviewSuite: ReturnType<typeof vi.fn>;
} {
  return {
    createTempDirectory: vi.fn().mockResolvedValue(ownedTempDirectory),
    removeTempDirectory: vi.fn().mockResolvedValue(undefined),
    removeTempDirectorySync: vi.fn((_tempDirectory: typeof ownedTempDirectory) => undefined),
    registerExitCleanup: vi.fn().mockReturnValue(vi.fn()),
    registerSignalCleanup: vi.fn().mockReturnValue(vi.fn()),
    authorizePreview: vi.fn().mockResolvedValue(accessToken),
    runPreviewSuite: vi.fn().mockResolvedValue(0),
  };
}

describe("preview E2E harness", () => {
  it("passes the in-memory token only to the child after authorization and cleans once", async () => {
    const deps = createDependencies();
    const parentEnvironment = {
      INHERITED: "value",
      OPTIMIST_PREVIEW_STORAGE_STATE: "/tmp/stale-storage-state.json",
    };

    await expect(runPreviewHarness(parentEnvironment, deps)).resolves.toBe(0);

    expect(deps.authorizePreview).toHaveBeenCalledWith({
      baseURL: "https://optimist-briefing-preview.optimistindustries.workers.dev",
    }, expect.any(AbortSignal));
    expect(deps.runPreviewSuite).toHaveBeenCalledWith({
      INHERITED: "value",
      OPTIMIST_PREVIEW_BASE_URL: baseURL,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_ACCESS_TOKEN: accessToken,
    }, expect.any(AbortSignal));
    expect(parentEnvironment).toEqual({
      INHERITED: "value",
      OPTIMIST_PREVIEW_STORAGE_STATE: "/tmp/stale-storage-state.json",
    });
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
    expect(deps.authorizePreview.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.runPreviewSuite.mock.invocationCallOrder[0]!,
    );
    expect(deps.runPreviewSuite.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.removeTempDirectory.mock.invocationCallOrder[0]!,
    );
    const unregister = deps.registerSignalCleanup.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(deps.removeTempDirectory.mock.invocationCallOrder[0]!).toBeLessThan(
      unregister.mock.invocationCallOrder[0]!,
    );
    expect(deps.registerExitCleanup).toHaveBeenCalledWith(ownedTempDirectory);
    expect(deps.createTempDirectory.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.registerExitCleanup.mock.invocationCallOrder[0]!,
    );
    expect(deps.registerExitCleanup.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.authorizePreview.mock.invocationCallOrder[0]!,
    );
    const unregisterExitCleanup = deps.registerExitCleanup.mock.results[0]
      ?.value as ReturnType<typeof vi.fn>;
    expect(deps.removeTempDirectory.mock.invocationCallOrder[0]!).toBeLessThan(
      unregisterExitCleanup.mock.invocationCallOrder[0]!,
    );
  });

  it("skips Playwright after authentication fails and still cleans once", async () => {
    const deps = createDependencies();
    deps.authorizePreview.mockRejectedValue(new Error("authentication failed"));

    await expect(runPreviewHarness({}, deps)).rejects.toThrow("authentication failed");

    expect(deps.runPreviewSuite).not.toHaveBeenCalled();
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("aborts and awaits authorization before cleaning", async () => {
    const deps = createDependencies();
    let signalCleanup: ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    let rejectAuthorization: ((error: Error) => void) | undefined;
    let activeSignal: AbortSignal | undefined;
    deps.registerSignalCleanup.mockImplementation((cleanup) => {
      signalCleanup = cleanup as unknown as (signal: NodeJS.Signals) => Promise<void>;
      return vi.fn();
    });
    deps.authorizePreview.mockImplementation((_input, signal) => new Promise<string>((_resolve, reject) => {
      activeSignal = signal;
      rejectAuthorization = reject;
    }));

    const running = runPreviewHarness({}, deps);
    await vi.waitFor(() => expect(deps.authorizePreview).toHaveBeenCalledOnce());
    const signalHandling = signalCleanup!("SIGINT");
    await Promise.resolve();
    expect(deps.removeTempDirectory).not.toHaveBeenCalled();
    expect(activeSignal?.aborted).toBe(true);
    rejectAuthorization!(new Error("authorization aborted"));

    await expect(signalHandling).resolves.toBeUndefined();
    await expect(running).resolves.toBe(1);
    expect(deps.runPreviewSuite).not.toHaveBeenCalled();
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("returns Playwright's exit code unchanged and still cleans once", async () => {
    const deps = createDependencies();
    deps.runPreviewSuite.mockResolvedValue(4);

    await expect(runPreviewHarness({}, deps)).resolves.toBe(4);

    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("aborts and awaits the active suite before signal cleanup", async () => {
    const deps = createDependencies();
    let signalCleanup: ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    let resolveSuite: ((code: number) => void) | undefined;
    let activeSignal: AbortSignal | undefined;
    deps.registerSignalCleanup.mockImplementation((cleanup) => {
      signalCleanup = cleanup as unknown as (signal: NodeJS.Signals) => Promise<void>;
      return vi.fn();
    });
    deps.runPreviewSuite.mockImplementation((_env, signal) => new Promise<number>((resolve) => {
      activeSignal = signal;
      resolveSuite = resolve;
    }));

    const running = runPreviewHarness({}, deps);
    await vi.waitFor(() => expect(deps.runPreviewSuite).toHaveBeenCalledOnce());
    const signalHandling = signalCleanup!("SIGTERM");
    await Promise.resolve();
    const cleanedBeforeChildExit = deps.removeTempDirectory.mock.calls.length > 0;
    const abortedWith = activeSignal?.reason;
    resolveSuite!(1);

    await expect(signalHandling).resolves.toBeUndefined();
    await expect(running).resolves.toBe(1);
    expect(cleanedBeforeChildExit).toBe(false);
    expect(activeSignal?.aborted).toBe(true);
    expect(abortedWith).toBe("SIGTERM");
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("uses the first concurrent signal and shares cleanup with finally", async () => {
    const deps = createDependencies();
    let signalCleanup: ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    let resolveSuite: ((code: number) => void) | undefined;
    let activeSignal: AbortSignal | undefined;
    deps.registerSignalCleanup.mockImplementation((cleanup) => {
      signalCleanup = cleanup as unknown as (signal: NodeJS.Signals) => Promise<void>;
      return vi.fn();
    });
    deps.runPreviewSuite.mockImplementation((_env, signal) => new Promise<number>((resolve) => {
      activeSignal = signal;
      resolveSuite = resolve;
    }));

    const running = runPreviewHarness({}, deps);
    await vi.waitFor(() => expect(deps.runPreviewSuite).toHaveBeenCalledOnce());
    const first = signalCleanup!("SIGTERM");
    const second = signalCleanup!("SIGINT");
    await Promise.resolve();
    resolveSuite!(1);

    await Promise.all([first, second, running]);
    expect(activeSignal?.reason).toBe("SIGTERM");
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("awaits and removes a temporary directory interrupted during creation", async () => {
    const deps = createDependencies();
    let signalCleanup: ((signal: NodeJS.Signals) => Promise<void>) | undefined;
    let resolveTempDirectory: ((path: typeof ownedTempDirectory) => void) | undefined;
    deps.registerSignalCleanup.mockImplementation((cleanup) => {
      signalCleanup = cleanup as unknown as (signal: NodeJS.Signals) => Promise<void>;
      return vi.fn();
    });
    deps.createTempDirectory.mockImplementation(() => new Promise<typeof ownedTempDirectory>((resolve) => {
      resolveTempDirectory = resolve;
    }));

    const running = runPreviewHarness({}, deps);
    await vi.waitFor(() => expect(deps.registerSignalCleanup).toHaveBeenCalledOnce());
    const signalHandling = signalCleanup!("SIGINT");
    resolveTempDirectory!(ownedTempDirectory);

    await expect(signalHandling).resolves.toBeUndefined();
    await expect(running).resolves.toBe(1);
    expect(deps.authorizePreview).not.toHaveBeenCalled();
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
    expect(deps.registerExitCleanup).toHaveBeenCalledWith(ownedTempDirectory);
  });

  it("keeps the exit fallback registered when asynchronous cleanup fails", async () => {
    const deps = createDependencies();
    deps.removeTempDirectory.mockRejectedValue(new Error("cleanup failed"));

    await expect(runPreviewHarness({}, deps)).rejects.toThrow("cleanup failed");

    const unregisterExitCleanup = deps.registerExitCleanup.mock.results[0]
      ?.value as ReturnType<typeof vi.fn>;
    expect(unregisterExitCleanup).not.toHaveBeenCalled();
  });

  it("recovers synchronously and never authenticates when exit cleanup registration fails", async () => {
    const deps = createDependencies();
    deps.registerExitCleanup.mockImplementation(() => {
      throw new Error("registration failed");
    });
    deps.removeTempDirectory.mockRejectedValue(new Error("async cleanup failed"));

    await expect(runPreviewHarness({}, deps)).rejects.toThrow();

    expect(deps.removeTempDirectorySync).toHaveBeenCalledWith(ownedTempDirectory);
    expect(deps.authorizePreview).not.toHaveBeenCalled();
    expect(deps.runPreviewSuite).not.toHaveBeenCalled();
  });
});
