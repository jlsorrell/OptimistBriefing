import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = [
  {
    path: "/",
    heading: "The day, thoughtfully distilled.",
    primaryControl: { role: "link" as const, name: "Optimist Briefing home" },
  },
  {
    path: "/archive",
    heading: "Archive",
    primaryControl: { role: "button" as const, name: "Apply filters" },
  },
  {
    path: "/preferences",
    heading: "Preferences",
    primaryControl: { role: "button" as const, name: "Save explicit preferences" },
  },
  {
    path: "/run-status",
    heading: "Run status",
    primaryControl: { role: "link" as const, name: "Return to today’s edition" },
  },
] as const;

for (const route of routes) {
  test(`${route.path} has no horizontal overflow and keeps its primary control usable`, async ({ page }) => {
    await page.goto(route.path);
    await expect(
      page.getByRole("heading", { level: 1, name: route.heading }),
    ).toBeVisible();
    await expect.poll(() => page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    )).toBe(true);

    const control = page.getByRole(route.primaryControl.role, {
      name: route.primaryControl.name,
      exact: true,
    });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  });

  test(`${route.path} has no serious or critical axe violations`, async ({ page }) => {
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
