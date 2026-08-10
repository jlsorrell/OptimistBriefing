import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";

import { D1BriefingRepository } from "../../../src/db/d1-repository";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    UPGRADE_DB: D1Database;
  }
}

function requiredMigration(name: string): D1Migration {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === name);
  if (migration === undefined) throw new TypeError(`Missing migration: ${name}`);
  return migration;
}

async function source(id: string, database = env.UPGRADE_DB) {
  const found = (await new D1BriefingRepository(database).listSources()).find(
    (entry) => entry.id === id,
  );
  if (found === undefined) throw new TypeError(`Missing source: ${id}`);
  return found;
}

async function executeMigrationSql(
  database: D1Database,
  migration: D1Migration,
): Promise<void> {
  await database.batch(
    migration.queries.map((query) => database.prepare(query)),
  );
}

const PRE_0011 = env.TEST_MIGRATIONS.filter(
  ({ name }) => name <= "0010_release_terminal_model_reservations.sql",
);

const MIGRATION_NAME = "0011_split_publication_url_policies.sql";

describe("publication URL policy migration", () => {
  it("splits the reviewed feed and article policies while retaining legacy policies", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const alignmentForumBefore = (await source("alignment-forum")).restrictions;

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("alignment-forum", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        urlPolicy: alignmentForumBefore.urlPolicy,
        feedUrlPolicy: {
          allowedHosts: ["www.alignmentforum.org"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/feed.xml"],
        },
        articleUrlPolicy: {
          allowedHosts: ["www.alignmentforum.org", "www.lesswrong.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/posts/"],
        },
      });
    expect((await source("lesswrong-curated", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        feedUrlPolicy: {
          allowedHosts: ["www.lesswrong.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/feed.xml"],
        },
        articleUrlPolicy: {
          allowedHosts: ["www.lesswrong.com"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/posts/"],
        },
      });
    expect((await source("mit-research", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        feedUrlPolicy: {
          allowedHosts: ["news.mit.edu"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/rss/"],
        },
        articleUrlPolicy: {
          allowedHosts: ["news.mit.edu"],
          allowedPorts: [""],
          allowedPathPrefixes: ["/202"],
        },
      });
    expect((await source("openai", env.UPGRADE_DB)).restrictions.pageUrl)
      .toBe("https://openai.com/research/index/publication/");
  });

  it("adds strict split policies for every legacy-policy catalog row", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const legacyPolicySourceIds = (await new D1BriefingRepository(
      env.UPGRADE_DB,
    ).listSources())
      .filter((entry) => entry.restrictions.urlPolicy !== undefined)
      .map((entry) => entry.id);

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    for (const id of legacyPolicySourceIds) {
      const restrictions = (await source(id, env.UPGRADE_DB)).restrictions;
      expect(restrictions.feedUrlPolicy).toMatchObject({
        allowedHosts: expect.arrayContaining([expect.any(String)]),
        allowedPorts: [""],
        allowedPathPrefixes: expect.arrayContaining([
          expect.stringMatching(/^\//),
        ]),
      });
      expect(restrictions.articleUrlPolicy).toMatchObject({
        allowedHosts: expect.arrayContaining([expect.any(String)]),
        allowedPorts: [""],
        allowedPathPrefixes: expect.arrayContaining([
          expect.stringMatching(/^\//),
        ]),
      });
    }
  });

  it("preserves a pre-existing custom split policy", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const mit = await source("mit-research", env.UPGRADE_DB);
    const customFeedUrlPolicy = {
      allowedHosts: ["feeds.operator.example"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/custom-feed.xml"],
    };
    const customArticleUrlPolicy = {
      allowedHosts: ["articles.operator.example"],
      allowedPorts: [""],
      allowedPathPrefixes: ["/papers/"],
    };
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    ).bind(
      JSON.stringify({
        ...mit.restrictions,
        feedUrlPolicy: customFeedUrlPolicy,
        articleUrlPolicy: customArticleUrlPolicy,
      }),
      "mit-research",
    ).run();

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("mit-research", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        urlPolicy: mit.restrictions.urlPolicy,
        feedUrlPolicy: customFeedUrlPolicy,
        articleUrlPolicy: customArticleUrlPolicy,
      });
  });

  it("preserves custom same-host split restrictions", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const mit = await source("mit-research", env.UPGRADE_DB);
    const customFeedUrlPolicy = {
      allowedHosts: ["news.mit.edu"],
      allowedPorts: ["8443"],
      allowedPathPrefixes: ["/operator-feed/"],
    };
    const customArticleUrlPolicy = {
      allowedHosts: ["news.mit.edu"],
      allowedPorts: ["8444"],
      allowedPathPrefixes: ["/operator-articles/"],
    };
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    ).bind(
      JSON.stringify({
        ...mit.restrictions,
        feedUrlPolicy: customFeedUrlPolicy,
        articleUrlPolicy: customArticleUrlPolicy,
      }),
      "mit-research",
    ).run();

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("mit-research", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        urlPolicy: mit.restrictions.urlPolicy,
        feedUrlPolicy: customFeedUrlPolicy,
        articleUrlPolicy: customArticleUrlPolicy,
      });
  });

  it("preserves explicit split policies that exactly equal the legacy policy", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const mit = await source("mit-research", env.UPGRADE_DB);
    const legacyPolicy = mit.restrictions.urlPolicy;
    const before = {
      ...mit.restrictions,
      feedUrlPolicy: legacyPolicy,
      articleUrlPolicy: legacyPolicy,
    };
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    ).bind(JSON.stringify(before), "mit-research").run();

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("mit-research", env.UPGRADE_DB)).restrictions)
      .toEqual(before);
  });

  it("fills a missing split peer without rewriting an explicit exact-legacy field", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const lessWrong = await source("lesswrong-curated", env.UPGRADE_DB);
    const legacyPolicy = lessWrong.restrictions.urlPolicy;
    const before = {
      ...lessWrong.restrictions,
      feedUrlPolicy: legacyPolicy,
    };
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    ).bind(JSON.stringify(before), "lesswrong-curated").run();

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("lesswrong-curated", env.UPGRADE_DB)).restrictions)
      .toEqual({
        ...before,
        articleUrlPolicy: legacyPolicy,
      });
  });

  it("fills a missing feed peer without rewriting an exact-legacy article policy", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const alignmentForum = await source("alignment-forum", env.UPGRADE_DB);
    const legacyPolicy = alignmentForum.restrictions.urlPolicy;
    const before = {
      ...alignmentForum.restrictions,
      articleUrlPolicy: legacyPolicy,
    };
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    ).bind(JSON.stringify(before), "alignment-forum").run();

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("alignment-forum", env.UPGRADE_DB)).restrictions)
      .toEqual({
        ...before,
        feedUrlPolicy: legacyPolicy,
      });
  });

  it("preserves a custom OpenAI page when split policies were absent", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const openai = await source("openai", env.UPGRADE_DB);
    const customPageUrl = "https://openai.com/research/custom-publications/";
    const before = {
      ...openai.restrictions,
      pageUrl: customPageUrl,
    };
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = ?",
    ).bind(JSON.stringify(before), "openai").run();

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("openai", env.UPGRADE_DB)).restrictions).toEqual({
      ...before,
      feedUrlPolicy: openai.restrictions.urlPolicy,
      articleUrlPolicy: openai.restrictions.urlPolicy,
    });
  });

  it.each([
    ["alignment-forum", "https://www.alignmentforum.org/operator-feed.xml"],
    ["lesswrong-curated", "https://www.lesswrong.com/operator-feed.xml"],
    ["mit-research", "https://news.mit.edu/rss/operator-feed"],
  ])(
    "preserves a custom %s feed endpoint when split policies were absent",
    async (sourceId, customFeedUrl) => {
      await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
      const current = await source(sourceId, env.UPGRADE_DB);
      const before = {
        ...current.restrictions,
        feedUrl: customFeedUrl,
      };
      await env.UPGRADE_DB.prepare(
        "UPDATE sources SET restrictions_json = ? WHERE id = ?",
      ).bind(JSON.stringify(before), sourceId).run();

      await applyD1Migrations(
        env.UPGRADE_DB,
        [requiredMigration(MIGRATION_NAME)],
      );

      expect((await source(sourceId, env.UPGRADE_DB)).restrictions).toEqual({
        ...before,
        feedUrlPolicy: current.restrictions.urlPolicy,
        articleUrlPolicy: current.restrictions.urlPolicy,
      });
    },
  );

  it.each([
    "alignment-forum",
    "lesswrong-curated",
    "mit-research",
    "openai",
  ])(
    "preserves a custom legacy policy for %s when split policies were absent",
    async (sourceId) => {
      await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
      const current = await source(sourceId, env.UPGRADE_DB);
      const customLegacyPolicy = {
        allowedHosts: ["operator.example"],
        allowedPorts: ["8443"],
        allowedPathPrefixes: ["/operator/"],
      };
      const before = {
        ...current.restrictions,
        urlPolicy: customLegacyPolicy,
      };
      await env.UPGRADE_DB.prepare(
        "UPDATE sources SET restrictions_json = ? WHERE id = ?",
      ).bind(JSON.stringify(before), sourceId).run();

      await applyD1Migrations(
        env.UPGRADE_DB,
        [requiredMigration(MIGRATION_NAME)],
      );

      expect((await source(sourceId, env.UPGRADE_DB)).restrictions).toEqual({
        ...before,
        feedUrlPolicy: customLegacyPolicy,
        articleUrlPolicy: customLegacyPolicy,
      });
    },
  );

  it("fills only missing split policy fields from the legacy policy", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const mit = await source("mit-research", env.UPGRADE_DB);
    const lessWrong = await source("lesswrong-curated", env.UPGRADE_DB);
    const customFeedUrlPolicy = {
      allowedHosts: ["news.mit.edu"],
      allowedPorts: ["8443"],
      allowedPathPrefixes: ["/operator-feed/"],
    };
    const customArticleUrlPolicy = {
      allowedHosts: ["www.lesswrong.com"],
      allowedPorts: ["8444"],
      allowedPathPrefixes: ["/operator-articles/"],
    };
    await env.UPGRADE_DB.batch([
      env.UPGRADE_DB.prepare(
        "UPDATE sources SET restrictions_json = ? WHERE id = ?",
      ).bind(
        JSON.stringify({
          ...mit.restrictions,
          feedUrlPolicy: customFeedUrlPolicy,
        }),
        "mit-research",
      ),
      env.UPGRADE_DB.prepare(
        "UPDATE sources SET restrictions_json = ? WHERE id = ?",
      ).bind(
        JSON.stringify({
          ...lessWrong.restrictions,
          articleUrlPolicy: customArticleUrlPolicy,
        }),
        "lesswrong-curated",
      ),
    ]);

    await applyD1Migrations(env.UPGRADE_DB, [requiredMigration(MIGRATION_NAME)]);

    expect((await source("mit-research", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        urlPolicy: mit.restrictions.urlPolicy,
        feedUrlPolicy: customFeedUrlPolicy,
        articleUrlPolicy: mit.restrictions.urlPolicy,
      });
    expect((await source("lesswrong-curated", env.UPGRADE_DB)).restrictions)
      .toMatchObject({
        urlPolicy: lessWrong.restrictions.urlPolicy,
        feedUrlPolicy: lessWrong.restrictions.urlPolicy,
        articleUrlPolicy: customArticleUrlPolicy,
      });
  });

  it("is idempotent after applying split policies", async () => {
    await applyD1Migrations(env.UPGRADE_DB, PRE_0011);
    const migration = requiredMigration(MIGRATION_NAME);

    await executeMigrationSql(env.UPGRADE_DB, migration);
    const once = await new D1BriefingRepository(env.UPGRADE_DB).listSources();
    await executeMigrationSql(env.UPGRADE_DB, migration);

    expect(await new D1BriefingRepository(env.UPGRADE_DB).listSources())
      .toEqual(once);
  });
});
