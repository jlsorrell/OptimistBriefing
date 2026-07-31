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
import {
  BudgetHardStopError,
  maximumEmbeddingUnits,
  maximumGenerationUnits,
  type BudgetReservation,
  type ModelBudgetRequest,
} from "./budget-gate";

export interface OpenAIModelProviderOptions {
  apiKey: string;
  generationModel: string;
  embeddingModel: string;
  maxTransportRetries?: number;
  onUsage?: (usage: ModelUsage) => void | Promise<void>;
  authorize?: (
    request: ModelBudgetRequest,
  ) => Promise<BudgetReservation | null>;
  reconcile?: (
    reservation: BudgetReservation,
    usage: ModelUsage,
  ) => Promise<void>;
  release?: (reservation: BudgetReservation) => Promise<void>;
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
  readonly #onUsage: ((usage: ModelUsage) => void | Promise<void>) | undefined;
  readonly #authorize:
    | ((request: ModelBudgetRequest) => Promise<BudgetReservation | null>)
    | undefined;
  readonly #reconcile:
    | ((reservation: BudgetReservation, usage: ModelUsage) => Promise<void>)
    | undefined;
  readonly #release:
    | ((reservation: BudgetReservation) => Promise<void>)
    | undefined;
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
    this.#authorize = options.authorize;
    this.#reconcile = options.reconcile;
    this.#release = options.release;
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
    const reservation = await this.#reserve({
      model: this.#embeddingModel,
      maximumBillableUnits: maximumEmbeddingUnits(texts),
    });
    let usage: ModelUsage | undefined;
    let response;
    try {
      response = await this.#withTransportRetry(() =>
        this.#client.embeddings.create({
          model: this.#embeddingModel,
          input: [...texts],
          encoding_format: "float",
        }),
      );
      usage = {
        provider: "openai",
        operation: "embedding",
        model: this.#embeddingModel,
        inputTokens: response.usage.prompt_tokens,
        outputTokens: 0,
        totalTokens: response.usage.total_tokens,
        embeddingCount: texts.length,
      };
      await this.#recordAndReconcile(reservation, usage);
    } catch (error) {
      if (usage === undefined) await this.#releaseReservation(reservation);
      throw error;
    }
    return [...response.data]
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.embedding);
  }

  async generateObject(
    input: GenerateObjectRequest,
  ): Promise<unknown> {
    const requestBody = {
      model: this.#generationModel,
      instructions: input.system,
      input: input.sourcePacket,
      max_output_tokens: input.maxOutputTokens,
      store: false as const,
      text: {
        format: {
          type: "json_schema" as const,
          name: input.schemaName,
          schema: input.jsonSchema,
          strict: true,
        },
      },
    };
    const serializedRequest = JSON.stringify(requestBody);
    const reservation = await this.#reserve({
      model: this.#generationModel,
      maximumBillableUnits: maximumGenerationUnits(
        serializedRequest,
        input.maxOutputTokens,
      ),
    });
    let usage: ModelUsage | undefined;
    let releaseAttempted = false;
    let response;
    try {
      response = await this.#withTransportRetry(() =>
        this.#client.responses.create(requestBody),
      );
      const responseUsage = response.usage;
      if (responseUsage !== undefined) {
        usage = {
          provider: "openai",
          operation: "generation",
          model: this.#generationModel,
          inputTokens: responseUsage.input_tokens,
          outputTokens: responseUsage.output_tokens,
          totalTokens: responseUsage.total_tokens,
          embeddingCount: 0,
        };
        await this.#recordAndReconcile(reservation, usage);
      } else {
        releaseAttempted = true;
        await this.#releaseReservation(reservation);
      }
    } catch (error) {
      if (usage === undefined && !releaseAttempted) {
        releaseAttempted = true;
        await this.#releaseReservation(reservation);
      }
      throw error;
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

  async #reserve(
    request: ModelBudgetRequest,
  ): Promise<BudgetReservation | undefined> {
    if (this.#authorize === undefined) return undefined;
    const reservation = await this.#authorize(request);
    if (reservation === null) throw new BudgetHardStopError();
    return reservation;
  }

  async #recordAndReconcile(
    reservation: BudgetReservation | undefined,
    usage: ModelUsage,
  ): Promise<void> {
    let recordError: unknown;
    try {
      await this.#recordUsage(usage);
    } catch (error) {
      recordError = error;
    }
    if (reservation !== undefined) {
      await this.#reconcile?.(reservation, usage);
    }
    if (recordError !== undefined) throw recordError;
  }

  async #releaseReservation(
    reservation: BudgetReservation | undefined,
  ): Promise<void> {
    if (reservation !== undefined) {
      await this.#release?.(reservation);
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

  async #recordUsage(usage: ModelUsage): Promise<void> {
    const record = Object.freeze({ ...usage });
    this.usage.push(record);
    await this.#onUsage?.(record);
  }
}
