import { describe, expect, it } from "vitest";

import {
  boundedSourceFailureLabels,
  settleSourceCollections,
} from "../../../src/sources/collection-settlement";
import { SourceFetchError } from "../../../src/sources/http-client";

describe("settleSourceCollections", () => {
  it("retains successful values and sanitizes typed fetch failures", async () => {
    const result = await settleSourceCollections([
      { sourceId: "ap", collect: async () => ["ok"] },
      {
        sourceId: "reuters",
        collect: async () => {
          throw new SourceFetchError({
            sourceId: "reuters",
            status: null,
            retryable: true,
            failureKind: "transport",
            reason: "secret URL",
          });
        },
      },
    ]);

    expect(result.values).toEqual(["ok"]);
    expect(result.failures).toEqual([
      { sourceId: "reuters", kind: "fetch" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret URL");
  });

  it("maps arbitrary failures to unknown and replaces malformed source IDs", async () => {
    const result = await settleSourceCollections([
      {
        sourceId: "  ",
        collect: async () => {
          throw new Error("private upstream detail");
        },
      },
    ]);

    expect(result).toEqual({
      values: [],
      failures: [{ sourceId: "unknown-source", kind: "unknown" }],
    });
    expect(JSON.stringify(result)).not.toContain("private upstream detail");
  });

  it("preserves the source collection receiver when invoking collect", async () => {
    const operation = {
      sourceId: "bound-source",
      value: "receiver value",
      async collect() {
        return [this.value];
      },
    };

    await expect(settleSourceCollections([operation])).resolves.toEqual({
      values: ["receiver value"],
      failures: [],
    });
  });

  it("settles a synchronously throwing collection without losing siblings", async () => {
    const result = await settleSourceCollections([
      {
        sourceId: "sync-failure",
        collect() {
          throw new SourceFetchError({
            sourceId: "sync-failure",
            status: null,
            retryable: true,
            failureKind: "transport",
            reason: "private synchronous detail",
          });
        },
      },
      {
        sourceId: "healthy-source",
        collect: async () => ["healthy value"],
      },
    ]);

    expect(result).toEqual({
      values: ["healthy value"],
      failures: [{ sourceId: "sync-failure", kind: "fetch" }],
    });
    expect(JSON.stringify(result)).not.toContain(
      "private synchronous detail",
    );
  });

  it("bounds broad-outage labels after suffixing in deterministic unique order", () => {
    const failures = [
      { sourceId: "a".repeat(200), kind: "fetch" as const },
      { sourceId: "duplicate", kind: "parse" as const },
      { sourceId: "duplicate", kind: "parse" as const },
      ...Array.from({ length: 70 }, (_, index) => ({
        sourceId: `source-${String(index).padStart(2, "0")}`,
        kind: "timeout" as const,
      })),
    ];

    const labels = boundedSourceFailureLabels(failures);

    expect(labels).toHaveLength(64);
    expect(labels).toEqual([...labels].sort());
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => [...label].length <= 200)).toBe(true);
    expect(labels).toContain("duplicate:parse");
    expect(labels.find((label) => label.endsWith(":fetch")))
      .toHaveLength(200);
  });
});
