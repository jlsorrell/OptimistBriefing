import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PREVIEW_ORIGIN,
  PREVIEW_TEMP_PREFIX,
  assertAuthenticationNavigation,
  normalizeChildExitCode,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
} from "../../../scripts/preview-e2e/environment";

const temporaryPaths: string[] = [];

async function createProtectedRuntimeState(): Promise<{
  tempDirectory: string;
  storageStatePath: string;
}> {
  const tempDirectory = await mkdtemp(join(tmpdir(), PREVIEW_TEMP_PREFIX));
  temporaryPaths.push(tempDirectory);
  await chmod(tempDirectory, 0o700);
  const storageStatePath = join(tempDirectory, "storage-state.json");
  await writeFile(storageStatePath, "{}", { mode: 0o600 });
  await chmod(storageStatePath, 0o600);
  return { tempDirectory, storageStatePath };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

describe("preview E2E environment", () => {
  it("defaults to and accepts only the canonical preview origin", () => {
    expect(resolvePreviewBaseURL(undefined)).toBe(PREVIEW_ORIGIN);
    expect(resolvePreviewBaseURL(`${PREVIEW_ORIGIN}/`)).toBe(PREVIEW_ORIGIN);
  });

  it.each([
    "http://optimist-briefing-preview.optimistindustries.workers.dev",
    "https://user@optimist-briefing-preview.optimistindustries.workers.dev",
    "https://optimist-briefing-preview.optimistindustries.workers.dev:8443",
    "https://optimist-briefing-preview.optimistindustries.workers.dev:443/",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/archive",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/?debug=1",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/?",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/#today",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/#",
    "https://optimist-briefing-preview.optimistindustries.workers.dev/%2e",
    "https://optimistindustries.com",
    "https://another-worker.optimistindustries.workers.dev",
  ])("rejects unsafe target %s", (value) => {
    expect(() => resolvePreviewBaseURL(value)).toThrow(
      "Preview E2E may only target the isolated preview origin",
    );
  });

  it("allows only the preview, Access team, and Google account origins during login", () => {
    expect(() => assertAuthenticationNavigation("about:blank")).not.toThrow();
    expect(() => assertAuthenticationNavigation(`${PREVIEW_ORIGIN}/health`)).not.toThrow();
    expect(() => assertAuthenticationNavigation("https://optimistindustries.cloudflareaccess.com/cdn-cgi/access/login/example")).not.toThrow();
    expect(() => assertAuthenticationNavigation("https://accounts.google.com/v3/signin/accountchooser")).not.toThrow();
    expect(() => assertAuthenticationNavigation("https://example.com/login")).toThrow(
      "Authentication left the approved origins",
    );
  });

  it("requires a real protected directory and exact protected storage-state file", async () => {
    const { tempDirectory, storageStatePath } = await createProtectedRuntimeState();
    expect(resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toEqual({ baseURL: PREVIEW_ORIGIN, tempDirectory, storageStatePath });
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: join(tempDirectory, "..", "state.json"),
    })).toThrow("Preview storage state must be the protected temporary file");
  });

  it("rejects a missing, non-regular, or non-0600 storage-state leaf", async () => {
    const { tempDirectory, storageStatePath } = await createProtectedRuntimeState();
    await chmod(storageStatePath, 0o644);
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toThrow("Preview storage state must be the protected temporary file");

    await rm(storageStatePath);
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toThrow("Preview storage state must be the protected temporary file");

    await symlink(tempDirectory, storageStatePath);
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toThrow("Preview storage state must be the protected temporary file");
  });

  it("rejects a storage-state file with another hard link", async () => {
    const { tempDirectory, storageStatePath } = await createProtectedRuntimeState();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "preview-runtime-hardlink-"));
    temporaryPaths.push(outsideDirectory);
    await link(storageStatePath, join(outsideDirectory, "linked-state.json"));

    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toThrow("Preview storage state must be the protected temporary file");
  });

  it("rejects a symlinked or non-0700 runtime directory", async () => {
    const { tempDirectory, storageStatePath } = await createProtectedRuntimeState();
    await chmod(tempDirectory, 0o755);
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: storageStatePath,
    })).toThrow("Preview storage state must be the protected temporary file");

    const targetDirectory = await mkdtemp(join(tmpdir(), "preview-runtime-target-"));
    const linkedDirectory = join(tmpdir(), `${PREVIEW_TEMP_PREFIX}runtime-link-${Date.now()}`);
    temporaryPaths.push(linkedDirectory, targetDirectory);
    await chmod(targetDirectory, 0o700);
    await writeFile(join(targetDirectory, "storage-state.json"), "{}", { mode: 0o600 });
    await symlink(targetDirectory, linkedDirectory);
    expect(() => resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: linkedDirectory,
      OPTIMIST_PREVIEW_STORAGE_STATE: join(linkedDirectory, "storage-state.json"),
    })).toThrow("Preview storage state must be the protected temporary file");
  });

  it("preserves child exit codes and maps signals to failure", () => {
    expect(normalizeChildExitCode(0, null)).toBe(0);
    expect(normalizeChildExitCode(7, null)).toBe(7);
    expect(normalizeChildExitCode(null, "SIGTERM")).toBe(1);
  });
});
