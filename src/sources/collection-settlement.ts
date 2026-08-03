import { ZodError } from "zod";

import { SourceFetchError } from "./http-client";
import { UnsafeOutboundUrlError } from "./outbound-url";
import {
  type CollectionBatch,
  type CollectionFailure,
  type CollectionFailureKind,
  CollectionFailureKindSchema,
  type SourceCollection,
} from "./types";

const VALID_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MAX_SOURCE_FAILURE_LABELS = 64;
const MAX_SOURCE_FAILURE_LABEL_CODE_POINTS = 200;

function publicSourceId(value: string): string {
  return VALID_SOURCE_ID.test(value) ? value : "unknown-source";
}

function collectionFailureKind(error: unknown): CollectionFailureKind {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return "parse";
  }
  if (error instanceof UnsafeOutboundUrlError) return "policy";
  if (!(error instanceof SourceFetchError)) return "unknown";
  if (error.failureKind === "policy") return "policy";
  return error.failureKind === "timeout" ? "timeout" : "fetch";
}

export function boundedSourceFailureLabels(
  failures: readonly CollectionFailure[],
): string[] {
  const labels = failures.map((failure) => {
    const suffix = `:${failure.kind}`;
    const sourceCodePoints = [...publicSourceId(failure.sourceId)];
    const maximumSourceCodePoints =
      MAX_SOURCE_FAILURE_LABEL_CODE_POINTS - [...suffix].length;
    return `${sourceCodePoints.slice(0, maximumSourceCodePoints).join("")}${suffix}`;
  });
  return [...new Set(labels)].sort().slice(0, MAX_SOURCE_FAILURE_LABELS);
}

export function boundedSourceFailureMetadata(
  labels: readonly string[],
): string[] {
  return boundedSourceFailureLabels(labels.map((label): CollectionFailure => {
    const separator = label.lastIndexOf(":");
    const kind = CollectionFailureKindSchema.safeParse(
      separator < 0 ? undefined : label.slice(separator + 1),
    );
    return {
      sourceId: separator < 0 ? label : label.slice(0, separator),
      kind: kind.success ? kind.data : "unknown",
    };
  }));
}

export async function settleSourceCollections<T>(
  operations: readonly SourceCollection<T>[],
): Promise<{ values: T[]; failures: CollectionFailure[] }> {
  const settled = await Promise.allSettled(
    operations.map(async (operation) => operation.collect()),
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
