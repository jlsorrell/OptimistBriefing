import { request } from "@playwright/test";

import { expect, test } from "./fixtures";

test("signed-out health requests are challenged by Access", async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Access boundary is viewport-independent");
  if (baseURL === undefined) throw new Error("Preview base URL is required");
  const anonymous = await request.newContext({ baseURL });
  try {
    const response = await anonymous.get("/health", { maxRedirects: 0 });
    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toContain(
      `${baseURL}/.well-known/cloudflare-access-protected-resource/health`,
    );
  } finally {
    await anonymous.dispose();
  }
});

test("authenticated health is exact", async ({ page }) => {
  const response = await page.goto("/health");
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toHaveText('{"status":"ok"}');
});
