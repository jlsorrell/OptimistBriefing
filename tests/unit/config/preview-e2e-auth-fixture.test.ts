import { afterEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_ORIGIN } from "../../../scripts/preview-e2e/environment";
import {
  getPreviewJSON,
  headersForPreviewRequest,
  routePreviewRequest,
} from "../../preview-e2e/fixtures";

const token = "synthetic-preview-token-1234";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("preview E2E bearer fixture", () => {
  it("adds authorization only for the exact preview origin while preserving headers", () => {
    expect(headersForPreviewRequest(
      `${PREVIEW_ORIGIN}/archive`,
      token,
      { accept: "text/html" },
    )).toEqual({
      accept: "text/html",
      authorization: `Bearer ${token}`,
    });
    expect(headersForPreviewRequest(
      "https://example.com/pixel",
      token,
      { accept: "image/*" },
    )).toEqual({ accept: "image/*" });
    expect(headersForPreviewRequest(
      `${PREVIEW_ORIGIN}.evil.example/`,
      token,
      {},
    )).toEqual({});
  });

  it.each([
    "https://example.com/api/runs",
    `${PREVIEW_ORIGIN}/api/runs`,
    "//example.com/api/runs",
  ])("rejects absolute request URL %s before invoking Playwright", async (path) => {
    vi.stubEnv("OPTIMIST_PREVIEW_ACCESS_TOKEN", token);
    const get = vi.fn();
    const page = {
      context: () => ({ request: { get } }),
    };

    await expect(getPreviewJSON(page as never, path)).rejects.toThrow(
      "Preview API requests must use a relative exact-origin path",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("requests a relative preview URL with the bearer token", async () => {
    vi.stubEnv("OPTIMIST_PREVIEW_ACCESS_TOKEN", token);
    const response = { status: () => 200 };
    const get = vi.fn().mockResolvedValue(response);
    const page = {
      context: () => ({ request: { get } }),
    };

    await expect(getPreviewJSON(page as never, "/api/runs?limit=1")).resolves.toBe(response);
    expect(get).toHaveBeenCalledWith(`${PREVIEW_ORIGIN}/api/runs?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    });
  });

  it("does not let an exact-origin bearer follow a redirect", async () => {
    const response = { status: () => 302 };
    const route = {
      request: () => ({
        url: () => `${PREVIEW_ORIGIN}/redirect`,
        headers: () => ({ accept: "text/html" }),
      }),
      continue: vi.fn(),
      fetch: vi.fn().mockResolvedValue(response),
      fulfill: vi.fn().mockResolvedValue(undefined),
    };

    await routePreviewRequest(route as never, token);

    expect(route.fetch).toHaveBeenCalledWith({
      headers: {
        accept: "text/html",
        authorization: `Bearer ${token}`,
      },
      maxRedirects: 0,
    });
    expect(route.fulfill).toHaveBeenCalledWith({ response });
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("continues an off-origin request without adding or forwarding a bearer", async () => {
    const route = {
      request: () => ({
        url: () => "https://example.com/pixel",
        headers: () => ({ accept: "image/*" }),
      }),
      continue: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn(),
      fulfill: vi.fn(),
    };

    await routePreviewRequest(route as never, token);

    expect(route.continue).toHaveBeenCalledWith();
    expect(route.fetch).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });
});
