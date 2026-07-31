import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const PREVIEW_ORIGIN =
  "https://optimist-briefing-preview.optimistindustries.workers.dev";
export const PREVIEW_TEMP_PREFIX = "optimist-preview-e2e-";

export function resolvePreviewBaseURL(value: string | undefined): string {
  if (value === undefined || value === PREVIEW_ORIGIN || value === `${PREVIEW_ORIGIN}/`) {
    return PREVIEW_ORIGIN;
  }
  throw new Error("Preview E2E may only target the isolated preview origin");
}

export function assertAuthenticationNavigation(value: string): void {
  if (value === "about:blank") return;
  const origin = new URL(value).origin;
  if (![PREVIEW_ORIGIN, "https://optimistindustries.cloudflareaccess.com",
        "https://accounts.google.com"].includes(origin)) {
    throw new Error("Authentication left the approved origins");
  }
}

function assertTemporaryDirectory(path: string): string {
  const candidate = resolve(path);
  if (dirname(candidate) !== resolve(tmpdir()) ||
      !basename(candidate).startsWith(PREVIEW_TEMP_PREFIX)) {
    throw new Error("Refusing unsafe preview cleanup target");
  }
  return candidate;
}

export function assertProtectedTemporaryDirectory(
  path: string,
): string {
  const candidate = assertTemporaryDirectory(path);
  try {
    const metadata = lstatSync(candidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o777) !== 0o700 ||
      dirname(realpathSync(candidate)) !== realpathSync(tmpdir())
    ) {
      throw new Error("unsafe directory");
    }
  } catch {
    throw new Error("Refusing unsafe preview temporary directory");
  }
  return candidate;
}

export function resolvePreviewStorageStatePath(
  tempDirectory: string,
  storageStatePath: string,
): string {
  const candidate = resolve(storageStatePath);
  if (candidate !== join(tempDirectory, "storage-state.json")) {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  return candidate;
}

function assertProtectedStorageStateFile(
  tempDirectory: string,
  storageStatePath: string,
): string {
  try {
    const protectedDirectory = assertProtectedTemporaryDirectory(tempDirectory);
    const candidate = resolvePreviewStorageStatePath(
      protectedDirectory,
      storageStatePath,
    );
    const metadata = lstatSync(candidate);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw new Error("unsafe storage state");
    }
    return candidate;
  } catch {
    throw new Error("Preview storage state must be the protected temporary file");
  }
}

export function resolvePreviewRuntimeEnvironment(env: NodeJS.ProcessEnv) {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  const rawTempDirectory = env.OPTIMIST_PREVIEW_TEMP_DIR;
  const rawStorageState = env.OPTIMIST_PREVIEW_STORAGE_STATE;
  if (rawTempDirectory === undefined || rawStorageState === undefined) {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  let tempDirectory: string;
  let storageStatePath: string;
  try {
    tempDirectory = assertProtectedTemporaryDirectory(rawTempDirectory);
    storageStatePath = assertProtectedStorageStateFile(
      tempDirectory,
      rawStorageState,
    );
  } catch {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  return { baseURL, tempDirectory, storageStatePath };
}

export function normalizeChildExitCode(
  code: number | null,
  _signal: NodeJS.Signals | null,
): number {
  return code ?? 1;
}
