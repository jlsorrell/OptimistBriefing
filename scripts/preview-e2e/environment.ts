import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export const PREVIEW_ORIGIN =
  "https://optimist-briefing-preview.optimistindustries.workers.dev";
export const PREVIEW_TEMP_PREFIX = "optimist-preview-e2e-";

export function resolvePreviewBaseURL(value: string | undefined): string {
  if (value === undefined || value === PREVIEW_ORIGIN || value === `${PREVIEW_ORIGIN}/`) {
    return PREVIEW_ORIGIN;
  }
  throw new Error("Preview E2E may only target the isolated preview origin");
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

export function resolvePreviewAccessToken(value: string | undefined): string {
  if (value === undefined || !/^[\x21-\x7E]{16,4096}$/.test(value)) {
    throw new Error("Preview access token is invalid");
  }
  return value;
}

export function resolvePreviewRuntimeEnvironment(env: NodeJS.ProcessEnv) {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  const rawTempDirectory = env.OPTIMIST_PREVIEW_TEMP_DIR;
  if (rawTempDirectory === undefined) {
    throw new Error("Refusing unsafe preview temporary directory");
  }
  const tempDirectory = assertProtectedTemporaryDirectory(rawTempDirectory);
  const accessToken = resolvePreviewAccessToken(env.OPTIMIST_PREVIEW_ACCESS_TOKEN);
  return { baseURL, tempDirectory, accessToken };
}

export function normalizeChildExitCode(
  code: number | null,
  _signal: NodeJS.Signals | null,
): number {
  return code ?? 1;
}
