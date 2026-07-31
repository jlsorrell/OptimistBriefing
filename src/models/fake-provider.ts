import type {
  GenerateObjectRequest,
  ModelProvider,
} from "./provider";

export interface FakeModelProviderOptions {
  generatedObjects?: readonly unknown[];
  embeddingBatches?: readonly (
    readonly (readonly number[])[]
  )[];
}

export class FakeModelProvider implements ModelProvider {
  readonly generateRequests: GenerateObjectRequest[] = [];
  readonly embedRequests: (readonly string[])[] = [];

  readonly #generatedObjects: unknown[];
  readonly #embeddingBatches: (readonly (readonly number[])[])[];

  constructor(options: FakeModelProviderOptions = {}) {
    this.#generatedObjects = [...(options.generatedObjects ?? [])];
    this.#embeddingBatches = [...(options.embeddingBatches ?? [])];
  }

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    this.embedRequests.push([...texts]);
    if (this.#embeddingBatches.length === 0) {
      throw new Error("No queued fake embedding batch.");
    }
    return this.#embeddingBatches.shift() ?? [];
  }

  async generateObject(
    input: GenerateObjectRequest,
  ): Promise<unknown> {
    this.generateRequests.push(structuredClone(input));
    if (this.#generatedObjects.length === 0) {
      throw new Error("No queued fake generated object.");
    }
    return this.#generatedObjects.shift();
  }
}
