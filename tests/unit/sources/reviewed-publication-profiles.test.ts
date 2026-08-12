import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

import { SourceHttpClient } from "../../../src/sources/http-client";
import { PublicationPageAdapter } from "../../../src/sources/publication-page";
import {
  REVIEWED_PUBLICATION_PROFILE_IDS,
  reviewedPublicationProfile,
} from "../../../src/sources/reviewed-publication-profiles";
import type { ResearchSourceRecord } from "../../../src/sources/types";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

const loadFixture = (name: string) => readFile(fixturePath(name), "utf8");

const window = {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-08-03T00:00:00.000Z",
};

function documentFrom(html: string): Document {
  return parseHTML(html).document;
}

function source(id: "anthropic" | "google-deepmind" | "google-research"): ResearchSourceRecord {
  const byId = {
    anthropic: {
      canonicalName: "Anthropic Research",
      canonicalUrl: "https://www.anthropic.com/research",
      pageUrl: "https://www.anthropic.com/research",
      path: "/research/",
    },
    "google-deepmind": {
      canonicalName: "Google DeepMind",
      canonicalUrl: "https://deepmind.google/",
      pageUrl: "https://deepmind.google/blog/",
      path: "/blog/",
    },
    "google-research": {
      canonicalName: "Google Research",
      canonicalUrl: "https://research.google/",
      pageUrl: "https://research.google/blog/",
      path: "/blog/",
    },
  }[id];
  return {
    id,
    canonicalName: byId.canonicalName,
    canonicalUrl: byId.canonicalUrl,
    role: "blog",
    enabled: true,
    sectionEligibility: ["research", "research_radar"],
    restrictions: {
      bodyRetrieval: "permitted",
      paywall: "none",
      contentUse: "ephemeral-summarization",
    },
  };
}

describe("reviewed publication profiles", () => {
  it("exposes only the three code-owned reviewed source IDs", () => {
    expect(REVIEWED_PUBLICATION_PROFILE_IDS).toEqual([
      "anthropic",
      "google-deepmind",
      "google-research",
    ]);
    expect(reviewedPublicationProfile("university-example")).toBeNull();
  });

  it("extracts Anthropic cards in listing order, preserving structural URLs and dates", async () => {
    const profile = reviewedPublicationProfile("anthropic")!;
    const html = await loadFixture("anthropic-research-listing.html");

    expect(profile.parseListing(
      documentFrom(html),
      "https://www.anthropic.com/research",
    )).toEqual([
      {
        title: "Alignment through debate",
        url: "https://www.anthropic.com/research/alignment-through-debate?ref=listing%2Faugust",
        publishedAt: "2026-08-02T00:00:00.000Z",
        summary: "A research method for scalable oversight and interpretable debate.",
        category: "AI safety",
        authors: [],
      },
      {
        title: "Mechanistic representations",
        url: "https://www.anthropic.com/research/representation-learning",
        publishedAt: "2026-08-01T00:00:00.000Z",
        summary: "Interpretability work on internal representation learning.",
        category: "Research",
        authors: [],
      },
      {
        title: "Console product release",
        url: "https://www.anthropic.com/products/console",
        publishedAt: "2026-08-02T00:00:00.000Z",
        summary: "A product update without a research topic.",
        category: "Product",
        authors: [],
      },
    ]);
  });

  it("excludes the direct-child display-date span from Anthropic fallback title and category selection", () => {
    const profile = reviewedPublicationProfile("anthropic")!;

    expect(profile.parseListing(documentFrom(`<!doctype html><a href="/research/span-title">
      <span>September 22, 2026</span>
      <span>Safety research</span>
      <span>Research</span>
      <time datetime="2026-09-22">September 22, 2026</time>
    </a>`), "https://www.anthropic.com/research")).toEqual([{
      title: "Safety research",
      url: "https://www.anthropic.com/research/span-title",
      publishedAt: "2026-09-22T00:00:00.000Z",
      summary: null,
      category: "Research",
      authors: [],
    }]);
  });

  it("extracts DeepMind month-only cards without manufacturing a date and prefers schema dates on details", async () => {
    const profile = reviewedPublicationProfile("google-deepmind")!;
    const listing = await loadFixture("deepmind-blog-listing.html");
    const detail = await loadFixture("deepmind-blog-detail.html");

    expect(profile.parseListing(documentFrom(listing), "https://deepmind.google/blog/")).toEqual([
      {
        title: "Evaluating AI systems for oversight",
        url: "https://deepmind.google/blog/evaluating-ai-systems?source=listing%2Faugust",
        publishedAt: null,
        summary: null,
        category: "Governance",
        authors: [],
      },
      {
        title: "Model launch product update",
        url: "https://deepmind.google/products/model-launch",
        publishedAt: "2026-08-02T00:00:00.000Z",
        summary: null,
        category: "Product",
        authors: [],
      },
    ]);
    expect(profile.parseDetailPublishedAt(documentFrom(detail)))
      .toBe("2026-08-02T00:00:00.000Z");
  });

  it("rejects unresolved detail timestamps instead of accepting their day prefix", () => {
    const profile = reviewedPublicationProfile("google-deepmind")!;

    expect(profile.parseDetailPublishedAt(documentFrom(`<!doctype html><time
      datetime="2026-08-02Tnot-a-time">August 2, 2026</time>`))).toBeNull();
  });

  it("extracts Google Research cards while isolating malformed siblings", async () => {
    const profile = reviewedPublicationProfile("google-research")!;
    const html = await loadFixture("google-research-blog-listing.html");

    expect(profile.parseListing(documentFrom(html), "https://research.google/blog/")).toEqual([
      {
        title: "Interpretable representations in neural networks",
        url: "https://research.google/blog/interpretable-representations?ref=listing%2Faugust",
        publishedAt: "2026-08-02T00:00:00.000Z",
        summary: "Mechanistic interpretability research for representation learning.",
        category: "Research",
        authors: [],
      },
      {
        title: "AI Studio product announcement",
        url: "https://research.google/products/ai-studio",
        publishedAt: "2026-08-02T00:00:00.000Z",
        summary: null,
        category: "Product",
        authors: [],
      },
    ]);
  });

  it("bounds provider-controlled display text before entries leave the profile", () => {
    const oversizedTitle = "ﬃ".repeat(500);
    const profile = reviewedPublicationProfile("anthropic")!;
    const entries = profile.parseListing(documentFrom(`<!doctype html><a href="/research/bounded">
      <h2>${oversizedTitle}</h2><span>AI safety</span><time datetime="2026-08-02"></time>
    </a>`), "https://www.anthropic.com/research");

    expect(entries[0]?.title).toHaveLength(500);
    expect(entries[0]?.title).toBe("ffi".repeat(166) + "ff");
  });

  it("does not inspect a valid reviewed row after twenty invalid matched nodes", () => {
    const invalidRows = Array.from({ length: 20 }, () => `<a href="/research/malformed">
      <span>Short</span><time datetime="2026-08-02"></time></a>`).join("");
    const profile = reviewedPublicationProfile("anthropic")!;

    expect(profile.parseListing(documentFrom(`${invalidRows}<a href="/research/later">
      <h2>Later AI safety research</h2><time datetime="2026-08-02"></time></a>`),
    "https://www.anthropic.com/research")).toEqual([]);
  });

  it("treats missing reviewed structure as parser drift instead of falling back to a generic article", async () => {
    const profile = reviewedPublicationProfile("anthropic")!;
    const adapter = new PublicationPageAdapter(
      new SourceHttpClient({
        fetch: vi.fn(async () => new Response(`<!doctype html><article>
          <h2>Generic AI safety article</h2>
          <a href="/research/generic">Read the generic card</a>
          <time datetime="2026-08-02"></time>
        </article>`, { headers: { "content-type": "text/html" } })),
        now: () => new Date("2026-08-02T12:00:00.000Z"),
      }),
      source("anthropic"),
      "https://www.anthropic.com/research",
      { allowedHosts: ["www.anthropic.com"], allowedPorts: [""], allowedPathPrefixes: ["/research"] },
      { allowedHosts: ["www.anthropic.com"], allowedPorts: [""], allowedPathPrefixes: ["/research/"] },
      undefined,
      profile,
    );

    await expect(adapter.collect(window)).rejects.toThrow(SyntaxError);
  });
});
