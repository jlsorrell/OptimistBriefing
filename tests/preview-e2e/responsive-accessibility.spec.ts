import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  ["/", "The day, thoughtfully distilled."],
  ["/archive", "Archive"],
  ["/preferences", "Preferences"],
  ["/run-status", "Run status"],
] as const;

for (const [path, heading] of routes) {
  test(`${path} has no horizontal overflow`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect.poll(() => page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )).toBe(true);
  });

  test(`${path} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      ),
    ).toEqual([]);
  });
}

test("uses the briefing menu only on mobile", async ({ page }, testInfo) => {
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Open briefing menu" });
  const navigation = page.getByRole("navigation", { name: "Briefing sections" });

  if (testInfo.project.name === "mobile") {
    await expect(menu).toBeVisible();
    await expect(navigation).toBeHidden();
    await menu.click();
    await expect(navigation).toBeVisible();
    await navigation.getByRole("link", { name: "Research", exact: true }).click();
    await expect(navigation).toBeHidden();
    await expect(page.locator(".reader-layout")).toHaveCSS("display", "block");
    return;
  }

  await expect(menu).toBeHidden();
  await expect(navigation).toBeVisible();
  await expect(page.locator(".reader-layout")).toHaveCSS("display", "grid");
});
