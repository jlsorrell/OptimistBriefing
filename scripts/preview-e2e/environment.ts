import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const PREVIEW_ORIGIN =
  "https://optimist-briefing-preview.optimistindustries.workers.dev";
export const PREVIEW_TEMP_PREFIX = "optimist-preview-e2e-";

export function resolvePreviewBaseURL(value: string | undefined): string {
  const url = new URL(value ?? PREVIEW_ORIGIN);
  if (url.origin !== PREVIEW_ORIGIN || url.username !== "" ||
      url.password !== "" || url.port !== "" || url.pathname !== "/" ||
      url.search !== "" || url.hash !== "") {
    throw new Error("Preview E2E may only target the isolated preview origin");
  }
  return url.origin;
}

export function assertAuthenticationNavigation(value: string): void {
  if (value === "about:blank") return;
  const origin = new URL(value).origin;
  if (![PREVIEW_ORIGIN, "https://optimistindustries.cloudflareaccess.com",
        "https://accounts.google.com"].includes(origin)) {
    throw new Error("Authentication left the approved origins");
  }
}

export function assertTemporaryDirectory(
  path: string,
  systemTempDirectory = tmpdir(),
): string {
  const candidate = resolve(path);
  if (dirname(candidate) !== resolve(systemTempDirectory) ||
      !basename(candidate).startsWith(PREVIEW_TEMP_PREFIX)) {
    throw new Error("Refusing unsafe preview cleanup target");
  }
  return candidate;
}

export function resolvePreviewRuntimeEnvironment(env: NodeJS.ProcessEnv) {
  const baseURL = resolvePreviewBaseURL(env.OPTIMIST_PREVIEW_BASE_URL);
  const rawTempDirectory = env.OPTIMIST_PREVIEW_TEMP_DIR;
  const rawStorageState = env.OPTIMIST_PREVIEW_STORAGE_STATE;
  if (rawTempDirectory === undefined || rawStorageState === undefined) {
    throw new Error("Preview storage state must be the protected temporary file");
  }
  const tempDirectory = assertTemporaryDirectory(rawTempDirectory);
  const storageStatePath = resolve(rawStorageState);
  if (storageStatePath !== join(tempDirectory, "storage-state.json")) {
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
