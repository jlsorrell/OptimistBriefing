import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runPreviewHarness,
  type PreviewHarnessDependencies,
} from "../../../scripts/preview-e2e/harness";

const tempDirectory = "/tmp/optimist-preview-e2e-unit";
const baseURL = "https://optimist-briefing-preview.optimistindustries.workers.dev";

function createDependencies(
): PreviewHarnessDependencies & {
  createTempDirectory: ReturnType<typeof vi.fn>;
  removeTempDirectory: ReturnType<typeof vi.fn>;
  registerSignalCleanup: ReturnType<typeof vi.fn>;
  captureAccessState: ReturnType<typeof vi.fn>;
  runPreviewSuite: ReturnType<typeof vi.fn>;
} {
  return {
    createTempDirectory: vi.fn().mockResolvedValue(tempDirectory),
    removeTempDirectory: vi.fn().mockResolvedValue(undefined),
    registerSignalCleanup: vi.fn().mockReturnValue(vi.fn()),
    captureAccessState: vi.fn().mockResolvedValue(undefined),
    runPreviewSuite: vi.fn().mockResolvedValue(0),
  };
}

describe("preview E2E harness", () => {
  it("authenticates before running Playwright and cleans the temporary directory once", async () => {
    const deps = createDependencies();

    await expect(runPreviewHarness({}, deps)).resolves.toBe(0);

    expect(deps.captureAccessState).toHaveBeenCalledWith({
      baseURL: "https://optimist-briefing-preview.optimistindustries.workers.dev",
      storageStatePath: join(tempDirectory, "storage-state.json"),
    });
    expect(deps.runPreviewSuite).toHaveBeenCalledWith({
      OPTIMIST_PREVIEW_BASE_URL: baseURL,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: join(tempDirectory, "storage-state.json"),
    });
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
    expect(deps.captureAccessState.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.runPreviewSuite.mock.invocationCallOrder[0]!,
    );
    expect(deps.runPreviewSuite.mock.invocationCallOrder[0]!).toBeLessThan(
      deps.removeTempDirectory.mock.invocationCallOrder[0]!,
    );
  });

  it("skips Playwright after authentication fails and still cleans once", async () => {
    const deps = createDependencies();
    deps.captureAccessState.mockRejectedValue(new Error("authentication failed"));

    await expect(runPreviewHarness({}, deps)).rejects.toThrow("authentication failed");

    expect(deps.runPreviewSuite).not.toHaveBeenCalled();
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("returns Playwright's exit code unchanged and still cleans once", async () => {
    const deps = createDependencies();
    deps.runPreviewSuite.mockResolvedValue(4);

    await expect(runPreviewHarness({}, deps)).resolves.toBe(4);

    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });

  it("cleans only once when signal cleanup runs before the suite finishes", async () => {
    const deps = createDependencies();
    let signalCleanup: (() => Promise<void>) | undefined;
    let resolveSuite: ((code: number) => void) | undefined;
    deps.registerSignalCleanup.mockImplementation((cleanup) => {
      signalCleanup = cleanup;
      return vi.fn();
    });
    deps.runPreviewSuite.mockImplementation(() => new Promise<number>((resolve) => {
      resolveSuite = resolve;
    }));

    const running = runPreviewHarness({}, deps);
    await vi.waitFor(() => expect(deps.runPreviewSuite).toHaveBeenCalledOnce());
    await signalCleanup!();
    resolveSuite!(0);

    await expect(running).resolves.toBe(0);
    expect(deps.removeTempDirectory).toHaveBeenCalledOnce();
  });
});
