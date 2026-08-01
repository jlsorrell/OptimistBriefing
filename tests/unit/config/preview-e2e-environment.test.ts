import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PREVIEW_ORIGIN,
  PREVIEW_TEMP_PREFIX,
  normalizeChildExitCode,
  resolvePreviewAccessToken,
  resolvePreviewBaseURL,
  resolvePreviewRuntimeEnvironment,
} from "../../../scripts/preview-e2e/environment";

const temporaryPaths: string[] = [];

async function createProtectedRuntimeDirectory(): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), PREVIEW_TEMP_PREFIX));
  temporaryPaths.push(tempDirectory);
  await chmod(tempDirectory, 0o700);
  return tempDirectory;
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

  it("requires the canonical origin, protected directory, and printable access token", async () => {
    const tempDirectory = await createProtectedRuntimeDirectory();
    const accessToken = "synthetic-preview-token-1234";
    expect(resolvePreviewRuntimeEnvironment({
      OPTIMIST_PREVIEW_BASE_URL: PREVIEW_ORIGIN,
      OPTIMIST_PREVIEW_TEMP_DIR: tempDirectory,
      OPTIMIST_PREVIEW_ACCESS_TOKEN: accessToken,
    })).toEqual({ baseURL: PREVIEW_ORIGIN, tempDirectory, accessToken });
  });

  it("accepts both access-token length boundaries", () => {
    expect(resolvePreviewAccessToken("!".repeat(16))).toBe("!".repeat(16));
    expect(resolvePreviewAccessToken("~".repeat(4096))).toBe("~".repeat(4096));
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too short", "short-token"],
    ["space-bearing", "synthetic preview token"],
    ["tab-bearing", "synthetic\tpreview-token"],
    ["newline-bearing", "synthetic-preview\ntoken"],
    ["carriage-return-bearing", "synthetic-preview\rtoken"],
    ["non-ASCII", "synthetic-preview-tokén"],
    ["implausibly long", "x".repeat(4097)],
  ])("rejects a %s token with one generic error and no value echo", (_name, value) => {
    let error: unknown;
    try {
      resolvePreviewAccessToken(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toEqual(new Error("Preview access token is invalid"));
    if (value === undefined) {
      expect(String(error)).not.toContain("undefined");
    } else if (value.length > 0) {
      expect(String(error)).not.toContain(value);
    }
  });

  it("preserves child exit codes and maps signals to failure", () => {
    expect(normalizeChildExitCode(0, null)).toBe(0);
    expect(normalizeChildExitCode(7, null)).toBe(7);
    expect(normalizeChildExitCode(null, "SIGTERM")).toBe(1);
  });
});
