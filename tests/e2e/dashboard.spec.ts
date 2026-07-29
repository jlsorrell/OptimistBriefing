import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { fixtureEdition } from "../../scripts/seed-dev";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/edition/latest", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureEdition()),
    });
  });
});

test("renders a source-grounded edition at desktop and mobile viewports", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "The day, thoughtfully distilled." }),
  ).toBeVisible();
  await expect(page.locator(".morning-list > li")).toHaveCount(3);
  await expect(
    page
      .locator('[data-entry-id="entry-featured-paper"]')
      .getByText("Abstract only"),
  ).toBeVisible();
  await expect(page.getByText("Primary source").first()).toBeVisible();
  await expect(page.getByText("Forecast — not a fact")).toBeVisible();
  await expect(
    page
      .locator('[data-entry-id="entry-forecast"]')
      .getByText("Forecast signal"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Thank you to arXiv for use of its open access interoperability.",
    ),
  ).toBeVisible();

  const palette = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      burgundy: styles.getPropertyValue("--burgundy").trim(),
      rose: styles.getPropertyValue("--rose").trim(),
      sage: styles.getPropertyValue("--sage").trim(),
      mustard: styles.getPropertyValue("--mustard").trim(),
      cream: styles.getPropertyValue("--cream").trim(),
    };
  });
  expect(palette).toEqual({
    burgundy: "#681f35",
    rose: "#c98d98",
    sage: "#89997d",
    mustard: "#c69a2d",
    cream: "#f7f0e5",
  });

  const menuButton = page.getByRole("button", { name: "Open briefing menu" });
  const navigation = page.getByRole("navigation", { name: "Briefing sections" });
  if (testInfo.project.name === "mobile") {
    await expect(menuButton).toBeVisible();
    await expect(navigation).toBeHidden();
    await menuButton.click();
    await expect(
      page.getByRole("button", { name: "Close briefing menu" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(navigation).toBeVisible();
    await page.getByRole("link", { name: /Research$/ }).click();
    await expect(navigation).toBeHidden();
    await expect(page.locator(".reader-layout")).toHaveCSS("display", "block");
  } else {
    await expect(menuButton).toBeHidden();
    await expect(navigation).toBeVisible();
    await expect(page.locator(".reader-layout")).toHaveCSS("display", "grid");
  }

  const save = page
    .locator('[data-entry-id="entry-featured-paper"]')
    .getByRole("button", { name: "Save" });
  await save.click();
  await expect(
    page
      .locator('[data-entry-id="entry-featured-paper"]')
      .getByRole("button", { name: "Saved" }),
  ).toHaveAttribute("aria-pressed", "true");

  const forecast = page.locator('[data-entry-id="entry-forecast"]');
  await forecast.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem("briefing-progress:2026-07-29"),
      ),
    )
    .toBe("entry-forecast");
});

test("preserves visible focus and has no serious automated accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  const firstSource = page.getByRole("link", { name: /Open paper/i }).first();
  await firstSource.focus();
  await expect(firstSource).toBeFocused();
  await expect(firstSource).toHaveCSS("outline-style", "solid");

  const results = await new AxeBuilder({ page })
    .disableRules(["landmark-unique"])
    .analyze();
  expect(
    results.violations.filter((violation) =>
      violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});
