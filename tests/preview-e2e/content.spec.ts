import type { Page } from "@playwright/test";

import { expect, getPreviewJSON, test } from "./fixtures";

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
const officialLabSourceIds = new Set([
  "anthropic",
  "google-deepmind",
  "google-research",
  "openai",
]);
const editionSections = [
  "morning_brief",
  "research",
  "research_radar",
  "world",
  "technology",
  "ai_policy",
  "dmv",
  "baltimore",
  "forecast",
] as const;

type PreviewEntry = {
  id: string;
  itemId: string | null;
  section: string;
  position: number;
  selectionReasons: string[];
  sourceRefs: Array<{
    id: string;
    name: string;
    url: string;
    role: string;
    retrievedAt: string;
  }>;
  summary: { title: string };
};

type PreviewEdition = Record<string, unknown> & { entries: PreviewEntry[] };

function previewEdition(body: unknown): PreviewEdition {
  if (body === null || typeof body !== "object") {
    throw new TypeError("Preview edition response must be an object");
  }
  const entries = (body as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new TypeError("Preview edition response must contain entries");
  }
  return { ...(body as Record<string, unknown>), entries } as PreviewEdition;
}

test("shows the fixed edition and leaves run state unchanged", async ({ page }) => {
  const runsBefore = await readArray(page, "/api/runs");
  const sources = await readArray(page, "/api/sources");
  expect(sources.length).toBeGreaterThan(0);

  const editionResponse = await getPreviewJSON(page, "/api/edition/latest");
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

test("renders layered research context and omits empty sections without mutation", async ({
  page,
}) => {
  const runsBefore = await readArray(page, "/api/runs");
  const response = await getPreviewJSON(page, "/api/edition/latest");
  expect(response.status()).toBe(200);
  const base = previewEdition(await response.json());
  const featuredTemplate = base.entries.find(({ section }) =>
    section === "research"
  );
  const newsTemplate = base.entries.find(({ section }) => section === "world");
  const policyTemplate = base.entries.find(({ section }) =>
    section === "ai_policy"
  ) ?? newsTemplate;
  if (
    featuredTemplate === undefined ||
    newsTemplate === undefined ||
    policyTemplate === undefined
  ) {
    throw new Error("Preview edition lacks representative render templates");
  }
  const retrievedAt = featuredTemplate.sourceRefs[0]?.retrievedAt;
  if (retrievedAt === undefined) {
    throw new Error("Featured preview template has no source timestamp");
  }
  const featured: PreviewEntry = {
    ...featuredTemplate,
    selectionReasons: [
      ...featuredTemplate.selectionReasons,
      "Independent implementation located.",
      "Substantive expert commentary located.",
    ],
    sourceRefs: [
      ...featuredTemplate.sourceRefs,
      {
        id: "alignment-forum",
        name: "Alignment Forum commentary",
        url: "https://www.alignmentforum.org/posts/preview-commentary",
        role: "blog",
        retrievedAt,
      },
    ],
  };
  const technology: PreviewEntry = {
    ...newsTemplate,
    id: "preview-layered-technology",
    itemId: "preview-layered-technology-item",
    section: "technology",
    position: 0,
    sourceRefs: [
      ...newsTemplate.sourceRefs,
      {
        id: "openai",
        name: "OpenAI Research",
        url: "https://openai.com/research/preview-product-release/",
        role: "blog",
        retrievedAt,
      },
    ],
  };
  const aiPolicy: PreviewEntry = {
    ...policyTemplate,
    id: "preview-layered-ai-policy",
    itemId: "preview-layered-ai-policy-item",
    section: "ai_policy",
    position: 0,
    sourceRefs: [
      ...policyTemplate.sourceRefs,
      {
        id: "google-deepmind",
        name: "Google DeepMind",
        url: "https://deepmind.google/discover/blog/preview-policy/",
        role: "blog",
        retrievedAt,
      },
    ],
  };
  const fixture: PreviewEdition = {
    ...base,
    entries: [
      ...base.entries
        .filter((entry) =>
          !["technology", "ai_policy", "forecast"].includes(entry.section)
        )
        .map((entry) => entry.id === featured.id ? featured : entry),
      technology,
      aiPolicy,
    ],
  };
  await page.route("**/api/edition/latest", async (route) => {
    await route.fulfill({ json: fixture });
  });

  await page.goto("/");
  const featuredCard = page.locator(".paper-card", {
    hasText: featured.summary.title,
  });
  await expect(featuredCard).toBeVisible();
  await featuredCard.locator(".selection-reasons summary").click();
  await expect(
    featuredCard.getByText("Independent implementation located.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    featuredCard.getByText("Substantive expert commentary located.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(featuredCard.getByText("Research blog", { exact: true }))
    .toBeVisible();

  const officialLabEntry = (section: "technology" | "ai_policy") =>
    fixture.entries.find((entry) =>
      entry.section === section &&
      entry.sourceRefs.some(({ id }) => officialLabSourceIds.has(id))
    );
  const renderedTechnology = officialLabEntry("technology");
  const renderedPolicy = officialLabEntry("ai_policy");
  expect(renderedTechnology?.itemId).toBe(technology.itemId);
  expect(renderedPolicy?.itemId).toBe(aiPolicy.itemId);
  expect(renderedTechnology?.itemId).not.toBe(renderedPolicy?.itemId);
  for (const [section, entry] of [
    ["technology", technology],
    ["ai_policy", aiPolicy],
  ] as const) {
    await expect(
      page.locator(`section#${section} .news-card`, {
        hasText: entry.summary.title,
      }),
    ).toBeVisible();
  }
  for (const section of editionSections) {
    const expectedCount = fixture.entries.filter((entry) =>
      entry.section === section
    ).length;
    const rendered = page.locator(`section#${section}`);
    if (expectedCount === 0) {
      await expect(rendered).toHaveCount(0);
    } else {
      await expect(rendered).toBeVisible();
      await expect(rendered.locator(".section-heading > span")).toHaveText(
        `${expectedCount} ${expectedCount === 1 ? "item" : "items"}`,
      );
    }
  }
  expect(await readArray(page, "/api/runs")).toEqual(runsBefore);
});

async function readArray(page: Page, path: string) {
  const response = await getPreviewJSON(page, path);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  expect(Array.isArray(body)).toBe(true);
  if (!Array.isArray(body)) throw new Error(`${path} did not return an array`);
  return body;
}
