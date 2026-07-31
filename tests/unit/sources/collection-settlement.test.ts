import { describe, expect, it } from "vitest";

import {
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
});
