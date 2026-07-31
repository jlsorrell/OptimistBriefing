import { expect, test } from "@playwright/test";

import { authenticateLocalPage } from "./local-access";

const routes = [
  {
    path: "/",
    heading: "The day, thoughtfully distilled.",
    control: { role: "link" as const, name: "Optimist Briefing home" },
  },
  {
    path: "/archive",
    heading: "Archive",
    control: { role: "button" as const, name: "Apply filters" },
  },
  {
    path: "/preferences",
    heading: "Preferences",
    control: { role: "button" as const, name: "Save explicit preferences" },
  },
  {
    path: "/run-status",
    heading: "Run status",
    control: { role: "link" as const, name: "Return to today’s edition" },
  },
] as const;

test.beforeEach(async ({ page }) => {
  await authenticateLocalPage(page);
});

for (const route of routes) {
  test(`${route.path} has no horizontal overflow and keeps its primary control usable`, async ({
    page,
  }) => {
    await page.goto(route.path);
    await expect(
      page.getByRole("heading", { level: 1, name: route.heading }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      )
      .toBe(true);

    const control = page.getByRole(route.control.role, {
      name: route.control.name,
    });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  });
}
