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
  const migration = env.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (migration === undefined) {
    throw new TypeError(`Required test migration is missing: ${name}`);
  }
  return migration;
}

async function source(id: string) {
  const found = (await new D1BriefingRepository(env.DB).listSources()).find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) throw new TypeError(`Missing source: ${id}`);
  return found;
}

describe("source feed refresh migration", () => {
  it("uses the current official WYPR and Baltimore Brew RSS endpoints", async () => {
    expect((await source("wypr")).restrictions).toMatchObject({
      feedUrl: "https://www.wypr.org/wypr-news.rss",
      urlPolicy: {
        allowedHosts: ["www.wypr.org"],
        allowedPorts: [""],
        allowedPathPrefixes: ["/wypr-news.rss", "/wypr-news/"],
      },
    });
    expect((await source("baltimore-brew")).restrictions).toMatchObject({
      feedUrl: "https://content.baltimorebrew.com/rss",
      urlPolicy: {
        allowedHosts: [
          "content.baltimorebrew.com",
          "www.baltimorebrew.com",
        ],
        allowedPorts: [""],
        allowedPathPrefixes: ["/rss", "/feed/", "/"],
      },
    });
  });

  it("is idempotent and preserves a customized feed URL", async () => {
    await applyD1Migrations(
      env.UPGRADE_DB,
      env.TEST_MIGRATIONS
        .filter(({ name }) => name < "0009_refresh_local_rss_feeds.sql"),
    );
    const repository = new D1BriefingRepository(env.UPGRADE_DB);
    const wypr = (await repository.listSources()).find(({ id }) => id === "wypr");
    if (wypr === undefined) throw new TypeError("Missing WYPR source");
    const customFeedUrl = "https://www.wypr.org/custom-news.rss";
    await env.UPGRADE_DB.prepare(
      "UPDATE sources SET restrictions_json = ? WHERE id = 'wypr'",
    ).bind(JSON.stringify({ ...wypr.restrictions, feedUrl: customFeedUrl })).run();

    const migration = requiredMigration("0009_refresh_local_rss_feeds.sql");
    await applyD1Migrations(env.UPGRADE_DB, [migration]);
    const once = await repository.listSources();
    await applyD1Migrations(env.UPGRADE_DB, [migration]);

    expect(
      (await repository.listSources()).find(({ id }) => id === "wypr")
        ?.restrictions.feedUrl,
    ).toBe(customFeedUrl);
    expect(await repository.listSources()).toEqual(once);
  });
});
