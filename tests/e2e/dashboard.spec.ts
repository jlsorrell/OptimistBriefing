import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import {
  authenticateLocalPage,
  signedLocalAssertion,
} from "./local-access";

test.beforeEach(async ({ page }) => {
  await authenticateLocalPage(page);
});

test("renders a source-grounded edition at desktop and mobile viewports", async ({
  page,
}, testInfo) => {
  const apiResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/edition/latest",
  );
  await page.goto("/");
  const apiResponse = await apiResponsePromise;
  expect(apiResponse.status()).toBe(200);
  await expect(apiResponse.json()).resolves.toMatchObject({
    id: "edition-2026-07-29",
    editionDate: "2026-07-29",
    entries: expect.arrayContaining([
      expect.objectContaining({ id: "entry-featured-paper" }),
    ]),
  });

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "The day, thoughtfully distilled.",
    }),
  ).toBeVisible();
  await expect(page.locator(".morning-list > li")).toHaveCount(3);
  await expect(
    page
      .locator('[data-entry-id="entry-featured-paper"]')
      .getByText("Abstract only"),
  ).toBeVisible();
  await expect(page.getByText("Primary source").first()).toBeVisible();
  await expect(page.getByText("Forecast, not fact")).toBeVisible();
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
  await forecast.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo({
      behavior: "instant",
      top: document.documentElement.scrollHeight,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.scrollY + window.innerHeight >=
          document.documentElement.scrollHeight - 2,
      ),
    )
    .toBe(true);
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
  const brand = page.getByRole("link", { name: "Optimist Briefing home" });
  await brand.focus();
  await expect(brand).toBeFocused();
  const focusColors = await brand.evaluate((element) => {
    const styles = getComputedStyle(element);
    const header = element.closest("header");
    if (header === null) throw new Error("Missing site header.");
    return {
      outline: styles.outlineColor,
      background: getComputedStyle(header).backgroundColor,
      width: styles.outlineWidth,
    };
  });
  expect(focusColors.width).toBe("3px");
  expect(
    contrastRatio(focusColors.outline, focusColors.background),
  ).toBeGreaterThanOrEqual(3);

  const results = await new AxeBuilder({ page })
    .disableRules(["landmark-unique"])
    .analyze();
  expect(
    results.violations.filter((violation) =>
      violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
});

test("the local stack rejects missing, mis-scoped, and invalid Access assertions", async ({
  request,
}) => {
  const unsignedPage = await request.get("/");
  expect(unsignedPage.status()).toBe(401);

  const valid = await signedLocalAssertion();
  const segments = valid.split(".");
  const signature = segments[2];
  if (segments.length !== 3 || signature === undefined) {
    throw new Error("Expected a compact signed JWT.");
  }
  const tamperedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  const invalidSignature = `${segments[0]}.${segments[1]}.${tamperedSignature}`;
  const assertions = [
    undefined,
    await signedLocalAssertion({ audience: "wrong-audience" }),
    await signedLocalAssertion({
      issuer: "https://wrong-issuer.optimist.invalid",
    }),
    invalidSignature,
  ];

  for (const assertion of assertions) {
    const response = await request.get("/api/edition/latest", {
      headers:
        assertion === undefined
          ? {}
          : { "CF-Access-Jwt-Assertion": assertion },
    });
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  }
});

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number);
  if (channels === undefined || channels.length !== 3) {
    throw new Error(`Expected an RGB color, received ${color}`);
  }
  const normalized = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (normalized[0] ?? 0) +
    0.7152 * (normalized[1] ?? 0) +
    0.0722 * (normalized[2] ?? 0)
  );
}
