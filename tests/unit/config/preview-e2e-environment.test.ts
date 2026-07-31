import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PREVIEW_ORIGIN,
  assertAuthenticationNavigation,
  assertTemporaryDirectory,
  normalizeChildExitCode,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
} from "../../../scripts/preview-e2e/environment";

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

  it("requires the exact storage-state child of the runner temp directory", () => {
    const tempDirectory = join(tmpdir(), "optimist-preview-e2e-unit");
    const storageStatePath = join(tempDirectory, "storage-state.json");
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

  it("rejects broad or unrelated cleanup targets", () => {
    expect(() => assertTemporaryDirectory(tmpdir())).toThrow(
      "Refusing unsafe preview cleanup target",
    );
    expect(() => assertTemporaryDirectory(join(tmpdir(), "unrelated"))).toThrow(
      "Refusing unsafe preview cleanup target",
    );
  });

  it("preserves child exit codes and maps signals to failure", () => {
    expect(normalizeChildExitCode(0, null)).toBe(0);
    expect(normalizeChildExitCode(7, null)).toBe(7);
    expect(normalizeChildExitCode(null, "SIGTERM")).toBe(1);
  });
});
