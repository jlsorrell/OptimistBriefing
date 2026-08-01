import { join } from "node:path";

import { resolvePreviewBaseURL } from "./environment";

export interface PreviewHarnessDependencies {
  createTempDirectory(): Promise<string>;
  removeTempDirectory(tempDirectory: string): Promise<void>;
  registerExitCleanup(tempDirectory: string): () => void;
  registerSignalCleanup(
    cleanup: (signal: NodeJS.Signals) => Promise<void>,
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
  let tempDirectory: string | undefined;
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
  const unregister = dependencies.registerSignalCleanup(shutdown);
  try {
    activeOperation = dependencies.createTempDirectory().then((createdDirectory) => {
      tempDirectory = createdDirectory;
      unregisterExitCleanup = dependencies.registerExitCleanup(createdDirectory);
      return createdDirectory;
    });
    await activeOperation;
    if (receivedSignal !== undefined) return 1;
    if (tempDirectory === undefined) throw new Error("Preview temporary directory was not created");
    const storageStatePath = join(tempDirectory, "storage-state.json");
    activeOperation = dependencies.captureAccessState(
      { baseURL, storageStatePath },
      abortController.signal,
    );
    await activeOperation;
    if (receivedSignal !== undefined) return 1;
    const suiteOperation = dependencies.runPreviewSuite({
      ...env,
      OPTIMIST_PREVIEW_BASE_URL: baseURL,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
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
