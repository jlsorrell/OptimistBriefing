import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";

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

async function reservationStatuses(): Promise<Record<string, string>> {
  const rows = await env.UPGRADE_DB.prepare(
    `SELECT run_id, status FROM model_budget_reservations
     WHERE id LIKE 'reserved-%' ORDER BY run_id`,
  ).all<{ run_id: string; status: string }>();
  return Object.fromEntries(rows.results.map((row) => [row.run_id, row.status]));
}

describe("terminal model budget cleanup migration", () => {
  it("releases only terminal-run reservations and is idempotent", async () => {
    const migrationName = "0010_release_terminal_model_reservations.sql";
    await applyD1Migrations(
      env.UPGRADE_DB,
      env.TEST_MIGRATIONS.filter(({ name }) => name < migrationName),
    );
    const createdAt = "2036-02-10T09:00:00.000Z";
    const statuses = [
      "pending",
      "running",
      "retryable",
      "partial",
      "failed",
      "published",
    ] as const;
    await env.UPGRADE_DB.batch(statuses.map((status, index) =>
      env.UPGRADE_DB.prepare(
        `INSERT INTO workflow_runs (
          id, edition_date, status, current_step, retryable, attempt_count,
          failure_code, estimated_cost_usd, created_at, updated_at
        ) VALUES (?, ?, ?, 'publish', 0, 1, NULL, 0, ?, ?)`,
      ).bind(
        status,
        `2036-02-${String(index + 10).padStart(2, "0")}`,
        status,
        createdAt,
        createdAt,
      )
    ));
    await env.UPGRADE_DB.batch([
      ...statuses.map((status) => env.UPGRADE_DB.prepare(
        `INSERT INTO model_budget_reservations (
          id, run_id, month_start, maximum_cost_microusd,
          actual_cost_microusd, status, created_at, updated_at
        ) VALUES (?, ?, ?, 100000, NULL, 'reserved', ?, ?)`,
      ).bind(
        `reserved-${status}`,
        status,
        "2036-02-01T00:00:00.000Z",
        createdAt,
        createdAt,
      )),
      env.UPGRADE_DB.prepare(
        `INSERT INTO model_budget_reservations (
          id, run_id, month_start, maximum_cost_microusd,
          actual_cost_microusd, status, created_at, updated_at
        ) VALUES (?, ?, ?, 100000, 50000, 'reconciled', ?, ?)`,
      ).bind(
        "reconciled-failed",
        "failed",
        "2036-02-01T00:00:00.000Z",
        createdAt,
        createdAt,
      ),
    ]);

    const migration = requiredMigration(migrationName);
    await applyD1Migrations(env.UPGRADE_DB, [migration]);
    const statusesAfterFirstApply = await reservationStatuses();
    const statusByRun = statusesAfterFirstApply;
    const reconciledStatus = await env.UPGRADE_DB.prepare(
      "SELECT status FROM model_budget_reservations WHERE id = ?",
    ).bind("reconciled-failed").first<string>("status");

    expect(statusByRun).toMatchObject({
      pending: "reserved",
      running: "reserved",
      retryable: "released",
      partial: "released",
      failed: "released",
      published: "released",
    });
    expect(reconciledStatus).toBe("reconciled");

    await applyD1Migrations(env.UPGRADE_DB, [migration]);
    const statusesAfterSecondApply = await reservationStatuses();
    expect(statusesAfterSecondApply).toEqual(statusesAfterFirstApply);
  });
});
