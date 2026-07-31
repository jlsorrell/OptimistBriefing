import { expect, request, test } from "@playwright/test";

test("signed-out health requests are challenged by Access", async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Access boundary is viewport-independent");
  if (baseURL === undefined) throw new Error("Preview base URL is required");
  const anonymous = await request.newContext({ baseURL });
  try {
    const response = await anonymous.get("/health", { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = response.headers().location;
    expect(location).toBeDefined();
    expect(new URL(location ?? "", baseURL).hostname).toBe(
      "optimistindustries.cloudflareaccess.com",
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
