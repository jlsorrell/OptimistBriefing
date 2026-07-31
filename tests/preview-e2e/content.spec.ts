import { expect, test, type Page } from "@playwright/test";

const sectionHeadings = ["Research", "World", "AI policy", "DMV", "Baltimore"] as const;
const sourceHosts = [
  "arxiv.org",
  "www.reuters.com",
  "www.thebaltimorebanner.com",
] as const;
const routeHeadings = [
  ["/archive", "Archive"],
  ["/preferences", "Preferences"],
  ["/run-status", "Run status"],
  ["/saved", "Saved items"],
] as const;

test("shows the fixed edition and leaves run state unchanged", async ({ page }) => {
  const runsBefore = await readArray(page, "/api/runs");
  const sources = await readArray(page, "/api/sources");
  expect(sources.length).toBeGreaterThan(0);

  const editionResponse = await page.context().request.get("/api/edition/latest");
  expect(editionResponse.status()).toBe(200);
  await expect(editionResponse.json()).resolves.toMatchObject({
    editionDate: "2026-07-29",
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "The day, thoughtfully distilled.",
    }),
  ).toBeVisible();
  await expect(page.locator(".header-date")).toContainText("July 29, 2026");
  for (const heading of sectionHeadings) {
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }
  await expect(page.getByText("Primary source").first()).toBeVisible();
  await expect(page.getByText("Forecast, not fact")).toBeVisible();

  const visibleSourceHosts = await page.locator(".source-list a").evaluateAll((links) =>
    links.map((link) => new URL((link as HTMLAnchorElement).href).hostname),
  );
  for (const hostname of sourceHosts) {
    expect(visibleSourceHosts).toContain(hostname);
  }

  for (const [path, heading] of routeHeadings) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }

  expect(await readArray(page, "/api/runs")).toEqual(runsBefore);
});

async function readArray(page: Page, path: string) {
  const response = await page.context().request.get(path);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) throw new Error(`${path} did not return an array`);
  return body;
}
