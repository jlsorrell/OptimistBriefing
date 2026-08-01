import { join } from "node:path";

import { resolvePreviewBaseURL } from "./environment";
import type { PreviewTempDirectoryOwnership } from "./temp-cleanup";

export interface PreviewHarnessDependencies {
  createTempDirectory(): Promise<PreviewTempDirectoryOwnership>;
  removeTempDirectory(tempDirectory: PreviewTempDirectoryOwnership): Promise<void>;
  removeTempDirectorySync(tempDirectory: PreviewTempDirectoryOwnership): void;
  registerExitCleanup(tempDirectory: PreviewTempDirectoryOwnership): () => void;
  registerSignalCleanup(
    cleanup: (signal: NodeJS.Signals) => Promise<void>,
    fallbackCleanup: () => void,
  ): () => void;
  captureAccessState(input: {
    baseURL: string;
    storageStatePath: string;
  }, signal: AbortSignal): Promise<void>;
  runPreviewSuite(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<number>;
}

export async function runPreviewHarness(
  env: NodeJS.ProcessEnv,
  dependencies: PreviewHarnessDependencies,
): Promise<number> {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  let tempDirectory: PreviewTempDirectoryOwnership | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let unregisterExitCleanup: (() => void) | undefined;
  const cleanup = () => {
    if (tempDirectory === undefined) return Promise.resolve();
    cleanupPromise ??= dependencies.removeTempDirectory(tempDirectory).then(() => {
      unregisterExitCleanup?.();
      unregisterExitCleanup = undefined;
    });
    return cleanupPromise;
  };
  const abortController = new AbortController();
  let activeOperation: Promise<unknown> | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals) => {
    if (receivedSignal === undefined) {
      receivedSignal = signal;
      abortController.abort(signal);
    }
    shutdownPromise ??= (async () => {
      try {
        await activeOperation;
      } catch {
        // The signal path deliberately suppresses operation details.
      }
      await cleanup();
    })();
    return shutdownPromise;
  };
  const unregister = dependencies.registerSignalCleanup(
    shutdown,
    () => {
      if (tempDirectory !== undefined) {
        dependencies.removeTempDirectorySync(tempDirectory);
      }
    },
  );
  try {
    activeOperation = dependencies.createTempDirectory().then(async (createdDirectory) => {
      tempDirectory = createdDirectory;
      try {
        unregisterExitCleanup = dependencies.registerExitCleanup(createdDirectory);
      } catch (error) {
        try {
          await dependencies.removeTempDirectory(createdDirectory);
        } catch {
          // The synchronous identity-bound cleanup below is the final recovery path.
        }
        dependencies.removeTempDirectorySync(createdDirectory);
        cleanupPromise = Promise.resolve();
        throw error;
      }
      return createdDirectory;
    });
    await activeOperation;
    if (receivedSignal !== undefined) return 1;
    if (tempDirectory === undefined) throw new Error("Preview temporary directory was not created");
    const storageStatePath = join(tempDirectory.path, "storage-state.json");
    activeOperation = dependencies.captureAccessState(
      { baseURL, storageStatePath },
      abortController.signal,
    );
    await activeOperation;
    if (receivedSignal !== undefined) return 1;
    const suiteOperation = dependencies.runPreviewSuite({
      ...env,
      OPTIMIST_PREVIEW_BASE_URL: baseURL,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory.path,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    }, abortController.signal);
    activeOperation = suiteOperation;
    return await suiteOperation;
  } catch (error) {
    if (receivedSignal !== undefined) return 1;
    throw error;
  } finally {
    try {
      await cleanup();
    } finally {
      unregister();
    }
  }
}
