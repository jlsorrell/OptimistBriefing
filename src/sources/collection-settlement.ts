import { ZodError } from "zod";

import { SourceFetchError } from "./http-client";
import {
  type CollectionBatch,
  type CollectionFailure,
  type CollectionFailureKind,
  type SourceCollection,
} from "./types";

const VALID_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function publicSourceId(value: string): string {
  return VALID_SOURCE_ID.test(value) ? value : "unknown-source";
}

function collectionFailureKind(error: unknown): CollectionFailureKind {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return "parse";
  }
  if (!(error instanceof SourceFetchError)) return "unknown";
  return error.failureKind === "policy" ? "policy" : "fetch";
}

export async function settleSourceCollections<T>(
  operations: readonly SourceCollection<T>[],
): Promise<{ values: T[]; failures: CollectionFailure[] }> {
  const settled = await Promise.allSettled(
    operations.map((operation) => operation.collect()),
  );
  const values: T[] = [];
  const failures: CollectionFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      values.push(...result.value);
      return;
    }
    failures.push({
      sourceId: publicSourceId(operations[index]?.sourceId ?? ""),
      kind: collectionFailureKind(result.reason),
    });
  });
  return { values, failures };
}

export async function settleCollectionBatch<T>(
  operations: readonly SourceCollection<T>[],
): Promise<CollectionBatch<T>> {
  const outcomes = await Promise.all(
    operations.map(async (operation) => ({
      sourceId: operation.sourceId,
      result: await settleSourceCollections([operation]),
    })),
  );
  return {
    candidates: outcomes.flatMap(({ result }) => result.values),
    succeededSourceIds: outcomes.flatMap(
      ({ sourceId, result }) =>
        result.failures.length === 0 ? [sourceId] : [],
    ),
    failures: outcomes.flatMap(({ result }) => result.failures),
  };
}
