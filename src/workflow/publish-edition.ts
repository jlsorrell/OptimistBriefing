import type { CompositionResult, PipelineContext } from "./types";

export async function publishEdition(
  context: PipelineContext,
  composition: CompositionResult,
): Promise<CompositionResult> {
  await context.store.persistEdition(
    composition.edition,
    composition.entries,
    composition.status === "failed" ? "draft" : composition.status,
  );
  return composition;
}
