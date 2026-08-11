import { expect, type Page } from "@playwright/test";

import {
  expectedCardSourceHosts,
  formatPreviewEditionDate,
  PREVIEW_SECTION_LABELS,
  PREVIEW_SECTIONS,
  type PreviewEdition,
} from "./edition-contract";

export async function expectRenderedPreviewEdition(
  page: Page,
  edition: PreviewEdition,
): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", {
    level: 1,
    name: "The day, thoughtfully distilled.",
  })).toBeVisible();
  await expect(page.locator(".header-date")).toHaveText(
    formatPreviewEditionDate(edition.editionDate),
  );

  for (const section of PREVIEW_SECTIONS) {
    const expected = edition.entries.filter((entry) => entry.section === section);
    const renderedSection = page.locator(`section#${section}`);
    if (expected.length === 0) {
      await expect(renderedSection).toHaveCount(0);
      continue;
    }
    await expect(renderedSection).toBeVisible();
    await expect(renderedSection.getByRole("heading", {
      level: 2,
      name: PREVIEW_SECTION_LABELS[section],
    })).toBeVisible();
    await expect(renderedSection.locator(".section-heading > span")).toHaveText(
      `${expected.length} ${expected.length === 1 ? "item" : "items"}`,
    );
    const renderedEntries = await renderedSection.locator("[data-entry-id]")
      .evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute("data-entry-id"),
        text: node.textContent ?? "",
      })));
    expect(renderedEntries.map(({ id }) => id)).toEqual(
      expected.map(({ id }) => id),
    );
    for (const [index, entry] of expected.entries()) {
      expect(renderedEntries[index]?.text).toContain(entry.summary.title);
    }
  }

  const renderedHosts = [...new Set(await page.locator(".source-list a")
    .evaluateAll((links) => links.map((link) =>
      new URL((link as HTMLAnchorElement).href).hostname
    )))].sort();
  expect(renderedHosts).toEqual(expectedCardSourceHosts(edition.entries));

  const researchPrimaryCount = edition.entries
    .filter(({ section }) => section === "research" || section === "research_radar")
    .flatMap(({ sourceRefs }) => sourceRefs)
    .filter(({ role }) => role === "primary").length;
  await expect(page.getByText("Primary source", { exact: true }))
    .toHaveCount(researchPrimaryCount);

  const forecastCount = edition.entries
    .filter(({ section }) => section === "forecast").length;
  await expect(page.getByText("Forecast, not fact", { exact: true }))
    .toHaveCount(forecastCount);
}
