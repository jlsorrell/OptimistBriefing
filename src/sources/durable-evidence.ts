import type { RawItem } from "./types";

export const MAX_DURABLE_EVIDENCE_CODE_POINTS = 2_000;

export function durableCollectedCandidate<T extends RawItem>(candidate: T): T {
  if (candidate.metadata.retention !== "ephemeral-only") return candidate;
  const normalized = (candidate.abstract ?? candidate.content ?? candidate.title)
    .replace(/\s+/gu, " ")
    .trim();
  const excerpt = [...normalized]
    .slice(0, MAX_DURABLE_EVIDENCE_CODE_POINTS)
    .join("");
  return {
    ...candidate,
    abstract: excerpt.length === 0 ? candidate.title : excerpt,
    content: null,
    metadata: { ...candidate.metadata, durableEvidence: true },
  };
}
