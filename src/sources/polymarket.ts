import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import { assertSafeOutboundUrl } from "./outbound-url";
import {
  CollectionWindowSchema,
  RawNewsCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionWindow,
  type NewsSourceAdapter,
  type RawNewsCandidate,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

const POLYMARKET_ENDPOINT = "https://gamma-api.polymarket.com/markets";

const ProbabilitySchema = z.number().finite().min(0).max(1);
const PolymarketMarketBaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().trim().min(1),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  updatedAt: z.string().datetime(),
  endDate: z.string().datetime(),
  resolutionSource: z.string().url(),
});
const NormalizedPolymarketMarketSchema =
  PolymarketMarketBaseSchema.extend({
    currentProbability: ProbabilitySchema,
    priorProbability: ProbabilitySchema,
    liquidity: z.number().finite().nonnegative().nullable(),
  });
const GammaPolymarketMarketSchema = PolymarketMarketBaseSchema.extend({
  outcomes: z.string().min(1),
  outcomePrices: z.string().min(1),
  oneDayPriceChange: z.number().finite().min(-1).max(1),
  liquidity: z.union([
    z.string().trim().min(1),
    z.number().finite().nonnegative(),
  ]),
});
const PolymarketResponseSchema = z.array(
  z.union([
    NormalizedPolymarketMarketSchema,
    GammaPolymarketMarketSchema,
  ]),
);
const PolymarketOptionsSchema = z.object({
  minimumLiquidity: z.number().finite().nonnegative(),
  minimumAbsoluteChange: z.number().finite().positive().max(1),
});

type PolymarketOptions = z.input<typeof PolymarketOptionsSchema>;

function roundedProbability(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type NormalizedPolymarketMarket = z.output<
  typeof NormalizedPolymarketMarketSchema
>;

function parseStringArray(value: string): string[] {
  return z.array(z.string()).parse(JSON.parse(value));
}

function normalizeMarket(
  market: z.output<typeof PolymarketResponseSchema>[number],
): NormalizedPolymarketMarket | null {
  if ("currentProbability" in market) {
    return market;
  }
  const outcomes = parseStringArray(market.outcomes);
  const prices = parseStringArray(market.outcomePrices);
  const yesIndex = outcomes.findIndex(
    (outcome) => outcome.trim().toLowerCase() === "yes",
  );
  if (yesIndex < 0) return null;
  const currentProbability = ProbabilitySchema.parse(
    Number(prices[yesIndex]),
  );
  const priorProbability = roundedProbability(
    currentProbability - market.oneDayPriceChange,
  );
  const normalized = {
    ...market,
    currentProbability,
    priorProbability,
    liquidity: Number(market.liquidity),
  };
  const result = NormalizedPolymarketMarketSchema.safeParse(normalized);
  return result.success ? result.data : null;
}

export class PolymarketAdapter implements NewsSourceAdapter {
  private readonly source: ResearchSourceRecord;
  private readonly options: z.output<typeof PolymarketOptionsSchema>;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    options: PolymarketOptions,
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    if (this.source.role !== "forecast") {
      throw new TypeError("Polymarket must be configured with forecast role.");
    }
    this.options = PolymarketOptionsSchema.parse(options);
  }

  async collect(window: CollectionWindow): Promise<RawNewsCandidate[]> {
    if (!this.source.enabled) return [];
    const validWindow = CollectionWindowSchema.parse(window);
    const endpoint = new URL(POLYMARKET_ENDPOINT);
    endpoint.searchParams.set("active", "true");
    endpoint.searchParams.set("closed", "false");
    endpoint.searchParams.set("limit", "100");
    const response = await this.http.get(
      this.source,
      endpoint.toString(),
      {
        headers: { accept: "application/json" },
        useValidators: false,
      },
    );
    if (response.body === null) return [];
    const markets = PolymarketResponseSchema.parse(
      JSON.parse(response.body),
    );

    return markets.flatMap((rawMarket): RawNewsCandidate[] => {
      const market = normalizeMarket(rawMarket);
      if (market === null) return [];
      const absoluteChange = roundedProbability(
        Math.abs(
          market.currentProbability - market.priorProbability,
        ),
      );
      if (
        market.updatedAt < validWindow.from ||
        market.updatedAt > validWindow.to ||
        market.liquidity === null ||
        market.liquidity < this.options.minimumLiquidity ||
        absoluteChange < this.options.minimumAbsoluteChange
      ) {
        return [];
      }
      let resolutionSource: string;
      try {
        resolutionSource = assertSafeOutboundUrl(
          market.resolutionSource,
        ).toString();
      } catch {
        return [];
      }
      const marketUrl = assertSafeOutboundUrl(
        `https://polymarket.com/event/${market.slug}`,
      ).toString();

      return [
        RawNewsCandidateSchema.parse({
          kind: "forecast",
          sourceId: this.source.id,
          sourceName: this.source.canonicalName,
          sourceRole: "forecast",
          title: market.question,
          originalUrl: marketUrl,
          externalId: `Polymarket:${market.id}`,
          externalIds: [`Polymarket:${market.id}`],
          publishedAt: market.updatedAt,
          retrievedAt: response.retrievedAt,
          accessLevel: "secondary",
          authors: [],
          institutions: [],
          abstract:
            `Probability moved from ${Math.round(
              market.priorProbability * 100,
            )}% to ${Math.round(market.currentProbability * 100)}%.`,
          content: null,
          relatedPaperIds: [],
          canCorroborateFacts: false,
          metadata: {
            currentProbability: market.currentProbability,
            priorProbability: market.priorProbability,
            absoluteChange,
            retrievedAt: response.retrievedAt,
            liquidity: market.liquidity,
            resolutionSource,
            resolvesAt: market.endDate,
            label: "Forecast, not fact",
          },
        }),
      ];
    });
  }
}
