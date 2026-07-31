import { describe, expect, it } from "vitest";

import {
  BudgetHardStopError,
  type BudgetReservation,
  type ModelBudgetRequest,
} from "../../../src/models/budget-gate";
import { OpenAIModelProvider } from "../../../src/models/openai-provider";
import type { ModelUsage } from "../../../src/models/provider";

const generationRequest = {
  model: "logical-summary",
  schemaName: "summary",
  jsonSchema: { type: "object" },
  system: "Use evidence.",
  sourcePacket: "évidence",
  maxOutputTokens: 900,
};

const reservation: BudgetReservation = {
  id: "reservation-1",
  maximumCostMicrousd: 1_000,
};

function successfulGenerationResponse(): Response {
  return new Response(JSON.stringify({
    model: "gpt-test",
    output_text: "{}",
    usage: {
      input_tokens: 8,
      output_tokens: 2,
      total_tokens: 10,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAIModelProvider budget authorization", () => {
  it("authorizes a conservative bound before the request and reconciles observed usage", async () => {
    const order: string[] = [];
    const authorized: ModelBudgetRequest[] = [];
    const reconciled: Array<{
      reservation: BudgetReservation;
      usage: ModelUsage;
    }> = [];
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "gpt-test",
      embeddingModel: "embedding-test",
      maxTransportRetries: 0,
      authorize: async (request) => {
        order.push("authorize");
        authorized.push(request);
        return reservation;
      },
      reconcile: async (held, usage) => {
        order.push("reconcile");
        reconciled.push({ reservation: held, usage });
      },
      fetch: async () => {
        order.push("fetch");
        return successfulGenerationResponse();
      },
    });

    await expect(provider.generateObject(generationRequest)).resolves.toEqual(
      {},
    );
    expect(order).toEqual(["authorize", "fetch", "reconcile"]);
    expect(authorized).toEqual([{
      model: "gpt-test",
      maximumBillableUnits: 1_108,
    }]);
    expect(reconciled).toEqual([{
      reservation,
      usage: {
        provider: "openai",
        operation: "generation",
        model: "gpt-test",
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        embeddingCount: 0,
      },
    }]);
  });

  it("stops before fetch when no live reservation fits", async () => {
    let fetchCalls = 0;
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "gpt-test",
      embeddingModel: "embedding-test",
      authorize: async () => null,
      fetch: async () => {
        fetchCalls += 1;
        return successfulGenerationResponse();
      },
    });

    await expect(provider.generateObject(generationRequest)).rejects.toEqual(
      new BudgetHardStopError(),
    );
    expect(fetchCalls).toBe(0);
  });

  it("keeps one reservation across retries and releases it after terminal no-usage failure", async () => {
    let authorizations = 0;
    let fetchCalls = 0;
    const released: BudgetReservation[] = [];
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "gpt-test",
      embeddingModel: "embedding-test",
      maxTransportRetries: 1,
      sleep: async () => undefined,
      authorize: async () => {
        authorizations += 1;
        return reservation;
      },
      release: async (held) => {
        released.push(held);
      },
      fetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({
          error: { message: "unavailable", type: "server_error" },
        }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(provider.generateObject(generationRequest)).rejects
      .toMatchObject({ status: 500 });
    expect(authorizations).toBe(1);
    expect(fetchCalls).toBe(2);
    expect(released).toEqual([reservation]);
  });

  it("uses UTF-8 bytes plus input count to authorize embeddings", async () => {
    const authorized: ModelBudgetRequest[] = [];
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "gpt-test",
      embeddingModel: "embedding-test",
      maxTransportRetries: 0,
      authorize: async (request) => {
        authorized.push(request);
        return reservation;
      },
      reconcile: async () => undefined,
      fetch: async () => new Response(JSON.stringify({
        model: "embedding-test",
        data: [
          { index: 0, embedding: [1, 0], object: "embedding" },
          { index: 1, embedding: [0, 1], object: "embedding" },
        ],
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await provider.embed(["one", "two"]);
    expect(authorized).toEqual([{
      model: "embedding-test",
      maximumBillableUnits: 8,
    }]);
  });

  it("preserves the maximum reservation when a successful response omits usage", async () => {
    let releaseCalls = 0;
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "gpt-test",
      embeddingModel: "embedding-test",
      maxTransportRetries: 0,
      authorize: async () => reservation,
      release: async () => {
        releaseCalls += 1;
      },
      fetch: async () => new Response(JSON.stringify({
        model: "gpt-test",
        output_text: "{}",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await expect(provider.generateObject(generationRequest)).resolves.toEqual(
      {},
    );
    expect(releaseCalls).toBe(0);
  });

  it("does not release the conservative maximum after observed usage if reconciliation fails", async () => {
    let releaseCalls = 0;
    const provider = new OpenAIModelProvider({
      apiKey: "test-key",
      generationModel: "gpt-test",
      embeddingModel: "embedding-test",
      maxTransportRetries: 0,
      authorize: async () => reservation,
      reconcile: async () => {
        throw new Error("RECONCILIATION_FAILED");
      },
      release: async () => {
        releaseCalls += 1;
      },
      fetch: async () => successfulGenerationResponse(),
    });

    await expect(provider.generateObject(generationRequest)).rejects.toThrow(
      "RECONCILIATION_FAILED",
    );
    expect(releaseCalls).toBe(0);
  });
});
