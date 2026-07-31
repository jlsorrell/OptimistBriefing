import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { authenticateLocalPage } from "./local-access";

const routes = [
  { name: "Today", path: "/", heading: "The day, thoughtfully distilled." },
  { name: "Archive", path: "/archive", heading: "Archive" },
  { name: "Preferences", path: "/preferences", heading: "Preferences" },
  { name: "Run Status", path: "/run-status", heading: "Run status" },
] as const;

test.beforeEach(async ({ page }) => {
  await authenticateLocalPage(page);
});

for (const route of routes) {
  test(`${route.name} has no serious or critical axe violations`, async ({
    page,
  }) => {
    await page.goto(route.path);
    await expect(
      page.getByRole("heading", { level: 1, name: route.heading }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
  });
}

test("Today exposes labeled navigation and a visible forecast label", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "The day, thoughtfully distilled.",
    }),
  ).toBeVisible();

  const menu = page.getByRole("button", { name: "Open briefing menu" });
  if (await menu.isVisible()) {
    await menu.click();
  }
  await expect(
    page.getByRole("navigation", { name: "Briefing sections" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Briefing tools" }),
  ).toBeVisible();
  const forecast = page.locator('[data-entry-id="entry-forecast"]');
  await expect(forecast.getByText("Forecast, not fact")).toBeVisible();
  await expect(forecast.getByText("Forecast signal")).toBeVisible();
});

test("keyboard focus remains visibly styled", async ({ page }) => {
  await page.goto("/");

  const brand = page.getByRole("link", { name: "Optimist Briefing home" });
  await brand.focus();
  await expect(brand).toBeFocused();
  const focusStyle = await brand.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(3);
});
