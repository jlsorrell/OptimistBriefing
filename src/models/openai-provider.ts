import OpenAI, {
  APIConnectionError,
  APIError,
  RateLimitError,
} from "openai";

import type {
  GenerateObjectRequest,
  ModelProvider,
  ModelUsage,
} from "./provider";

export interface OpenAIModelProviderOptions {
  apiKey: string;
  generationModel: string;
  embeddingModel: string;
  maxTransportRetries?: number;
  onUsage?: (usage: ModelUsage) => void;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const MAX_TRANSPORT_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 30_000;

export class OpenAIModelProvider implements ModelProvider {
  readonly usage: ModelUsage[] = [];

  readonly #client: OpenAI;
  readonly #generationModel: string;
  readonly #embeddingModel: string;
  readonly #maxTransportRetries: number;
  readonly #onUsage: ((usage: ModelUsage) => void) | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: OpenAIModelProviderOptions) {
    const maxTransportRetries = options.maxTransportRetries ?? 2;
    if (
      !Number.isInteger(maxTransportRetries) ||
      maxTransportRetries < 0 ||
      maxTransportRetries > MAX_TRANSPORT_RETRIES
    ) {
      throw new RangeError(
        `maxTransportRetries must be an integer from 0 to ${MAX_TRANSPORT_RETRIES}.`,
      );
    }
    this.#client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#generationModel = options.generationModel;
    this.#embeddingModel = options.embeddingModel;
    this.#maxTransportRetries = maxTransportRetries;
    this.#onUsage = options.onUsage;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
  }

  async embed(
    texts: readonly string[],
  ): Promise<readonly (readonly number[])[]> {
    const response = await this.#withTransportRetry(() =>
      this.#client.embeddings.create({
        model: this.#embeddingModel,
        input: [...texts],
        encoding_format: "float",
      }),
    );
    this.#recordUsage({
      operation: "embedding",
      model: response.model,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: 0,
      totalTokens: response.usage.total_tokens,
    });
    return [...response.data]
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.embedding);
  }

  async generateObject(
    input: GenerateObjectRequest,
  ): Promise<unknown> {
    const response = await this.#withTransportRetry(() =>
      this.#client.responses.create({
        model: this.#generationModel,
        instructions: input.system,
        input: input.sourcePacket,
        max_output_tokens: input.maxOutputTokens,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: input.schemaName,
            schema: input.jsonSchema,
            strict: true,
          },
        },
      }),
    );
    const usage = response.usage;
    if (usage !== undefined) {
      this.#recordUsage({
        operation: "generation",
        model: response.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      });
    }
    try {
      return JSON.parse(response.output_text) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        return response.output_text;
      }
      throw error;
    }
  }

  async #withTransportRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (
      let attempt = 0;
      attempt <= this.#maxTransportRetries;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof APIConnectionError ||
          error instanceof RateLimitError ||
          (error instanceof APIError &&
            error.status !== undefined &&
            error.status >= 500);
        if (!retryable || attempt === this.#maxTransportRetries) {
          throw error;
        }
        await this.#sleep(this.#retryDelayMilliseconds(error, attempt));
      }
    }
    throw new Error("Unreachable model retry state.");
  }

  #retryDelayMilliseconds(error: unknown, attempt: number): number {
    if (error instanceof APIError) {
      const retryAfter = error.headers?.get("retry-after");
      if (retryAfter !== null && retryAfter !== undefined) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
          return Math.min(
            MAX_RETRY_DELAY_MS,
            Math.round(seconds * 1_000),
          );
        }
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) {
          return Math.min(
            MAX_RETRY_DELAY_MS,
            Math.max(0, retryAt - Date.now()),
          );
        }
      }
    }
    return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt);
  }

  #recordUsage(usage: ModelUsage): void {
    const record = Object.freeze({ ...usage });
    this.usage.push(record);
    this.#onUsage?.(record);
  }
}
