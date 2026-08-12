import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";

import { D1BriefingRepository } from "../../../src/db/d1-repository";
import type { DiscoveryMechanism } from "../../../src/db/repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    UPGRADE_DB: D1Database;
  }
}

const MIGRATION_NAME = "0012_non_arxiv_research_sources.sql";
const LESSWRONG_FRONTPAGE_URL =
  "https://www.lesswrong.com/feed.xml?view=frontpage&karmaThreshold=20";

const PAPERS_WITH_CODE_POLICY = {
  allowedHosts: ["paperswithcode.co"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/"],
};
const DEEPMIND_OLD_POLICY = {
  allowedHosts: ["deepmind.google"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/discover/blog/"],
};
const DEEPMIND_POLICY = {
  allowedHosts: ["deepmind.google"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/blog/"],
};
const ANTHROPIC_OLD_POLICY = {
  allowedHosts: ["www.anthropic.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/research"],
};
const ANTHROPIC_ARTICLE_POLICY = {
  allowedHosts: ["www.anthropic.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/research/"],
};
const GOOGLE_RESEARCH_POLICY = {
  allowedHosts: ["research.google"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/blog/"],
};
const OPENAI_OLD_FEED_POLICY = {
  allowedHosts: ["openai.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/research/index/publication/"],
};
const OPENAI_ARTICLE_POLICY = {
  allowedHosts: ["openai.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/index/", "/research/"],
};
const OPENAI_FEED_POLICY = {
  allowedHosts: ["openai.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/news/rss.xml"],
};
const LESSWRONG_FEED_POLICY = {
  allowedHosts: ["www.lesswrong.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/feed.xml"],
};
const LESSWRONG_ARTICLE_POLICY = {
  allowedHosts: ["www.lesswrong.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/posts/"],
};

function requiredMigration(name: string): D1Migration {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === name);
  if (migration === undefined) {
    throw new TypeError(`Required test migration is missing: ${name}`);
  }
  return migration;
}

const THROUGH_0011 = env.TEST_MIGRATIONS.filter(
  ({ name }) => name <= "0011_split_publication_url_policies.sql",
);

async function applyThrough0011(database = env.UPGRADE_DB): Promise<void> {
  await applyD1Migrations(database, THROUGH_0011);
}

async function execute0012(database = env.UPGRADE_DB): Promise<void> {
  const migration = requiredMigration(MIGRATION_NAME);
  await database.batch(
    migration.queries.map((query) => database.prepare(query)),
  );
}

async function listSources(database = env.UPGRADE_DB) {
  return new D1BriefingRepository(database).listSources();
}

async function source(id: string, database = env.UPGRADE_DB) {
  const found = (await listSources(database)).find((entry) => entry.id === id);
  if (found === undefined) throw new TypeError(`Missing source: ${id}`);
  return found;
}

async function replaceRestrictions(
  id: string,
  restrictions: Record<string, unknown>,
  discoveryMechanism?: DiscoveryMechanism,
): Promise<void> {
  const current = await source(id);
  await env.UPGRADE_DB.prepare(
    "UPDATE sources SET restrictions_json = ? WHERE id = ?",
  ).bind(
    JSON.stringify({
      ...restrictions,
      discoveryMechanism: discoveryMechanism ?? current.discoveryMechanism,
      sectionEligibility: current.sectionEligibility,
    }),
    id,
  ).run();
}

async function rawSourceRows(database = env.UPGRADE_DB) {
  return (await database.prepare(
    `SELECT id, canonical_name, canonical_url, role, trust_prior, enabled,
       restrictions_json, last_success_at, health_status
     FROM sources
     ORDER BY id`,
  ).all()).results;
}

function without(
  restrictions: Record<string, unknown>,
  ...keys: readonly string[]
): Record<string, unknown> {
  const result = { ...restrictions };
  for (const key of keys) delete result[key];
  return result;
}

function customPolicy(path = "/operator/") {
  return {
    allowedHosts: ["operator.example"],
    allowedPorts: ["8443"],
    allowedPathPrefixes: [path],
  };
}

describe("non-arXiv research source migration", () => {
  it("installs the reviewed catalog records with unique canonical URLs and readable restrictions", async () => {
    const sources = await listSources(env.DB);
    const byId = new Map(sources.map((entry) => [entry.id, entry]));

    expect(new Set(sources.map((entry) => entry.canonicalUrl)).size).toBe(
      sources.length,
    );
    expect(sources.map((entry) => entry.canonicalName)).toEqual(
      [...sources.map((entry) => entry.canonicalName)].sort(),
    );

    expect(byId.get("papers-with-code-co")).toMatchObject({
      discoveryMechanism: "page",
      restrictions: {
        pageUrl: "https://paperswithcode.co/papers/recent",
        feedUrlPolicy: PAPERS_WITH_CODE_POLICY,
        articleUrlPolicy: PAPERS_WITH_CODE_POLICY,
      },
    });
    expect(byId.get("google-deepmind")).toMatchObject({
      discoveryMechanism: "page",
      restrictions: {
        pageUrl: "https://deepmind.google/blog/",
        feedUrlPolicy: DEEPMIND_POLICY,
        articleUrlPolicy: DEEPMIND_POLICY,
      },
    });
    expect(byId.get("anthropic")).toMatchObject({
      discoveryMechanism: "page",
      restrictions: {
        pageUrl: "https://www.anthropic.com/research",
        feedUrlPolicy: ANTHROPIC_OLD_POLICY,
        articleUrlPolicy: ANTHROPIC_ARTICLE_POLICY,
      },
    });
    expect(byId.get("google-research")).toMatchObject({
      discoveryMechanism: "page",
      restrictions: {
        pageUrl: "https://research.google/blog/",
        feedUrlPolicy: GOOGLE_RESEARCH_POLICY,
        articleUrlPolicy: GOOGLE_RESEARCH_POLICY,
      },
    });
    expect(byId.get("openai")).toMatchObject({
      discoveryMechanism: "rss",
      restrictions: {
        feedUrl: "https://openai.com/news/rss.xml",
        feedUrlPolicy: OPENAI_FEED_POLICY,
        articleUrlPolicy: OPENAI_ARTICLE_POLICY,
      },
    });
    expect(byId.get("openai")?.restrictions.pageUrl).toBeUndefined();
    expect(byId.get("lesswrong-frontpage")).toMatchObject({
      canonicalName: "LessWrong Frontpage",
      canonicalUrl: LESSWRONG_FRONTPAGE_URL,
      role: "blog",
      trustPrior: 0.8,
      enabled: true,
      discoveryMechanism: "rss",
      restrictions: {
        feedUrl: LESSWRONG_FRONTPAGE_URL,
        feedUrlPolicy: LESSWRONG_FEED_POLICY,
        articleUrlPolicy: LESSWRONG_ARTICLE_POLICY,
      },
    });
  });

  it.each([
    {
      id: "papers-with-code-co",
      expected: {
        discoveryMechanism: "page",
        restrictions: {
          pageUrl: "https://paperswithcode.co/papers/recent",
          feedUrlPolicy: PAPERS_WITH_CODE_POLICY,
          articleUrlPolicy: PAPERS_WITH_CODE_POLICY,
        },
      },
    },
    {
      id: "google-deepmind",
      expected: {
        discoveryMechanism: "page",
        restrictions: {
          pageUrl: "https://deepmind.google/blog/",
          feedUrlPolicy: DEEPMIND_POLICY,
          articleUrlPolicy: DEEPMIND_POLICY,
        },
      },
    },
    {
      id: "anthropic",
      expected: {
        discoveryMechanism: "page",
        restrictions: {
          pageUrl: "https://www.anthropic.com/research",
          feedUrlPolicy: ANTHROPIC_OLD_POLICY,
          articleUrlPolicy: ANTHROPIC_ARTICLE_POLICY,
        },
      },
    },
    {
      id: "google-research",
      expected: {
        discoveryMechanism: "page",
        restrictions: {
          pageUrl: "https://research.google/blog/",
          feedUrlPolicy: GOOGLE_RESEARCH_POLICY,
          articleUrlPolicy: GOOGLE_RESEARCH_POLICY,
        },
      },
    },
    {
      id: "openai",
      expected: {
        discoveryMechanism: "rss",
        restrictions: {
          feedUrl: "https://openai.com/news/rss.xml",
          feedUrlPolicy: OPENAI_FEED_POLICY,
          articleUrlPolicy: OPENAI_ARTICLE_POLICY,
        },
      },
    },
  ])("upgrades the exact reviewed 0011 default for $id", async ({ id, expected }) => {
    await applyThrough0011();

    await execute0012();

    expect(await source(id)).toMatchObject(expected);
  });

  it.each([
    {
      label: "Papers with Code endpoint update",
      id: "papers-with-code-co",
      absentPolicies: false,
    },
    {
      label: "DeepMind endpoint update",
      id: "google-deepmind",
      absentPolicies: false,
    },
    {
      label: "Anthropic exact-policy update",
      id: "anthropic",
      absentPolicies: false,
    },
    {
      label: "Anthropic absent-policy fill",
      id: "anthropic",
      absentPolicies: true,
    },
    {
      label: "Google Research absent-policy fill",
      id: "google-research",
      absentPolicies: true,
    },
    {
      label: "OpenAI feed conversion",
      id: "openai",
      absentPolicies: false,
    },
  ])("preserves $label for a non-page discovery mechanism", async ({
    id,
    absentPolicies,
  }) => {
    await applyThrough0011();
    const before = await source(id);
    const restrictions = absentPolicies
      ? without(
          before.restrictions,
          "feedUrlPolicy",
          "articleUrlPolicy",
        )
      : before.restrictions;
    await replaceRestrictions(id, restrictions, "manual");

    await execute0012();

    const after = await source(id);
    expect(after.discoveryMechanism).toBe("manual");
    expect(after.restrictions).toEqual(restrictions);
  });

  it.each([
    ["papers-with-code-co", "pageUrl", "https://paperswithcode.co/operator"],
    ["google-deepmind", "pageUrl", "https://deepmind.google/operator/"],
    ["anthropic", "pageUrl", "https://www.anthropic.com/operator/"],
    ["google-research", "pageUrl", "https://research.google/operator/"],
    ["openai", "pageUrl", "https://openai.com/research/operator/"],
  ] as const)(
    "preserves a custom %s endpoint",
    async (id, field, value) => {
      await applyThrough0011();
      const before = await source(id);
      const restrictions = { ...before.restrictions, [field]: value };
      await replaceRestrictions(id, restrictions);

      await execute0012();

      expect((await source(id)).restrictions).toEqual(restrictions);
    },
  );

  it("preserves a pre-existing OpenAI feed endpoint", async () => {
    await applyThrough0011();
    const before = await source("openai");
    const restrictions = {
      ...before.restrictions,
      feedUrl: "https://openai.com/news/operator.xml",
    };
    await replaceRestrictions("openai", restrictions);

    await execute0012();

    expect((await source("openai")).restrictions).toEqual(restrictions);
  });

  it.each([
    ["papers-with-code-co", "feedUrlPolicy"],
    ["google-deepmind", "feedUrlPolicy"],
    ["anthropic", "feedUrlPolicy"],
    ["google-research", "feedUrlPolicy"],
    ["openai", "feedUrlPolicy"],
  ] as const)("preserves a custom %s %s", async (id, field) => {
    await applyThrough0011();
    const before = await source(id);
    const restrictions = {
      ...before.restrictions,
      [field]: customPolicy("/custom-feed/"),
    };
    await replaceRestrictions(id, restrictions);

    await execute0012();

    expect((await source(id)).restrictions).toEqual(restrictions);
  });

  it.each([
    ["papers-with-code-co", "articleUrlPolicy"],
    ["google-deepmind", "articleUrlPolicy"],
    ["anthropic", "articleUrlPolicy"],
    ["google-research", "articleUrlPolicy"],
    ["openai", "articleUrlPolicy"],
  ] as const)("preserves a custom %s %s", async (id, field) => {
    await applyThrough0011();
    const before = await source(id);
    const restrictions = {
      ...before.restrictions,
      [field]: customPolicy("/custom-article/"),
    };
    await replaceRestrictions(id, restrictions);

    await execute0012();

    expect((await source(id)).restrictions).toEqual(restrictions);
  });

  it.each([
    ["papers-with-code-co", "feedUrlPolicy"],
    ["papers-with-code-co", "articleUrlPolicy"],
    ["google-deepmind", "feedUrlPolicy"],
    ["google-deepmind", "articleUrlPolicy"],
    ["anthropic", "feedUrlPolicy"],
    ["anthropic", "articleUrlPolicy"],
    ["google-research", "feedUrlPolicy"],
    ["google-research", "articleUrlPolicy"],
    ["openai", "feedUrlPolicy"],
    ["openai", "articleUrlPolicy"],
  ] as const)(
    "preserves a %s record when %s is absent",
    async (id, absentPolicy) => {
      await applyThrough0011();
      const before = await source(id);
      const restrictions = without(before.restrictions, absentPolicy);
      await replaceRestrictions(id, restrictions);

      await execute0012();

      expect((await source(id)).restrictions).toEqual(restrictions);
    },
  );

  it("preserves an explicit legacy DeepMind feed policy when its article sibling is custom", async () => {
    await applyThrough0011();
    const before = await source("google-deepmind");
    const restrictions = {
      ...before.restrictions,
      feedUrlPolicy: DEEPMIND_OLD_POLICY,
      articleUrlPolicy: customPolicy("/operator-article/"),
    };
    await replaceRestrictions("google-deepmind", restrictions);

    await execute0012();

    expect((await source("google-deepmind")).restrictions).toEqual(
      restrictions,
    );
  });

  it.each([
    ["anthropic", ANTHROPIC_OLD_POLICY, ANTHROPIC_ARTICLE_POLICY],
    ["google-research", GOOGLE_RESEARCH_POLICY, GOOGLE_RESEARCH_POLICY],
  ] as const)(
    "fills both absent split policies for the reviewed %s endpoint",
    async (id, feedUrlPolicy, articleUrlPolicy) => {
      await applyThrough0011();
      const before = await source(id);
      const restrictions = without(
        before.restrictions,
        "feedUrlPolicy",
        "articleUrlPolicy",
      );
      await replaceRestrictions(id, restrictions);

      await execute0012();

      expect((await source(id)).restrictions).toEqual({
        ...restrictions,
        feedUrlPolicy,
        articleUrlPolicy,
      });
    },
  );

  it.each([
    {
      id: "papers-with-code-co",
      expectedPatch: {
        pageUrl: "https://paperswithcode.co/papers/recent",
      },
    },
    {
      id: "google-deepmind",
      expectedPatch: {
        pageUrl: "https://deepmind.google/blog/",
        feedUrlPolicy: DEEPMIND_POLICY,
        articleUrlPolicy: DEEPMIND_POLICY,
      },
    },
  ] as const)(
    "upgrades the reviewed $id endpoint when both split policies are absent",
    async ({ id, expectedPatch }) => {
      await applyThrough0011();
      const before = await source(id);
      const restrictions = without(
        before.restrictions,
        "feedUrlPolicy",
        "articleUrlPolicy",
      );
      await replaceRestrictions(id, restrictions);

      await execute0012();

      expect((await source(id)).restrictions).toEqual({
        ...restrictions,
        ...expectedPatch,
      });
    },
  );

  it.each(["anthropic", "google-research"])(
    "does not fill absent split policies when %s has a custom endpoint",
    async (id) => {
      await applyThrough0011();
      const before = await source(id);
      const restrictions = {
        ...without(before.restrictions, "feedUrlPolicy", "articleUrlPolicy"),
        pageUrl: `https://operator.example/${id}/`,
      };
      await replaceRestrictions(id, restrictions);

      await execute0012();

      expect((await source(id)).restrictions).toEqual(restrictions);
    },
  );

  it("does not recreate an operator-deleted catalog source", async () => {
    await applyThrough0011();
    await env.UPGRADE_DB.prepare("DELETE FROM sources WHERE id = ?")
      .bind("google-research")
      .run();

    await execute0012();

    expect((await listSources()).find((entry) => entry.id === "google-research"))
      .toBeUndefined();
  });

  it("preserves a pre-existing LessWrong Frontpage source", async () => {
    await applyThrough0011();
    const restrictions = {
      discoveryMechanism: "rss",
      sectionEligibility: ["research"],
      feedUrl: "https://operator.example/frontpage.xml",
      feedUrlPolicy: customPolicy("/frontpage.xml"),
      articleUrlPolicy: customPolicy("/posts/"),
    };
    await env.UPGRADE_DB.prepare(
      `INSERT INTO sources (
        id, canonical_name, canonical_url, role, trust_prior, enabled,
        restrictions_json, last_success_at, health_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "lesswrong-frontpage",
      "Operator LessWrong Frontpage",
      "https://operator.example/lesswrong-frontpage",
      "blog",
      0.4,
      0,
      JSON.stringify(restrictions),
      "2026-08-12T00:00:00.000Z",
      "healthy",
    ).run();

    await execute0012();

    expect(await source("lesswrong-frontpage")).toMatchObject({
      canonicalName: "Operator LessWrong Frontpage",
      canonicalUrl: "https://operator.example/lesswrong-frontpage",
      enabled: false,
      healthStatus: "healthy",
      discoveryMechanism: "rss",
      sectionEligibility: ["research"],
      restrictions: without(restrictions, "discoveryMechanism", "sectionEligibility"),
    });
  });

  it("does not replace a source that already owns the Frontpage canonical URL", async () => {
    await applyThrough0011();
    await env.UPGRADE_DB.prepare(
      `INSERT INTO sources (
        id, canonical_name, canonical_url, role, trust_prior, enabled,
        restrictions_json, last_success_at, health_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "operator-lesswrong-collision",
      "Operator LessWrong Collision",
      LESSWRONG_FRONTPAGE_URL,
      "blog",
      0.4,
      0,
      "{}",
      null,
      "unknown",
    ).run();

    await execute0012();

    expect(await source("operator-lesswrong-collision")).toMatchObject({
      canonicalUrl: LESSWRONG_FRONTPAGE_URL,
      enabled: false,
    });
    expect((await listSources()).find((entry) => entry.id === "lesswrong-frontpage"))
      .toBeUndefined();
  });

  it("is idempotent when the raw migration SQL executes twice", async () => {
    await applyThrough0011();

    await execute0012();
    const once = await rawSourceRows();
    await execute0012();

    expect(await rawSourceRows()).toEqual(once);
  });
});
