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

    await applyD1Migrations(env.UPGRADE_DB, [migration]);
    const once = await new D1BriefingRepository(env.UPGRADE_DB).listSources();
    await applyD1Migrations(env.UPGRADE_DB, [migration]);

    expect(await new D1BriefingRepository(env.UPGRADE_DB).listSources())
      .toEqual(once);
  });
});
