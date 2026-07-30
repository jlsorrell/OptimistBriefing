import type { CompositionResult, PipelineContext } from "./types";

export async function publishEdition(
  context: PipelineContext,
  composition: CompositionResult,
): Promise<CompositionResult> {
  if (composition.status === "failed") return composition;
  await context.store.publish(composition.edition.id, composition.status);
  return composition;
}
