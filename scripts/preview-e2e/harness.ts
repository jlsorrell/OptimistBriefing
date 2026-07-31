import { join } from "node:path";

import { resolvePreviewBaseURL } from "./environment";

export interface PreviewHarnessDependencies {
  createTempDirectory(): Promise<string>;
  removeTempDirectory(tempDirectory: string): Promise<void>;
  registerSignalCleanup(cleanup: () => Promise<void>): () => void;
  captureAccessState(input: {
    baseURL: string;
    storageStatePath: string;
  }): Promise<void>;
  runPreviewSuite(env: NodeJS.ProcessEnv): Promise<number>;
}

export async function runPreviewHarness(
  env: NodeJS.ProcessEnv,
  dependencies: PreviewHarnessDependencies,
): Promise<number> {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  const tempDirectory = await dependencies.createTempDirectory();
  const storageStatePath = join(tempDirectory, "storage-state.json");
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= dependencies.removeTempDirectory(tempDirectory);
    return cleanupPromise;
  };
  const unregister = dependencies.registerSignalCleanup(cleanup);
  try {
    await dependencies.captureAccessState({ baseURL, storageStatePath });
    return await dependencies.runPreviewSuite({
      ...env,
      OPTIMIST_PREVIEW_BASE_URL: baseURL,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    });
  } finally {
    unregister();
    await cleanup();
  }
}
