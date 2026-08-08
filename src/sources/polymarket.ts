import { z } from "zod";

import { SourceHttpClient } from "./http-client";
import { deriveNewsSignals } from "./news-signals";
import { assertSafeOutboundUrl } from "./outbound-url";
import {
  boundProviderText,
  normalizedProviderSignalText,
} from "./provider-text";
import {
  CollectionWindowSchema,
  MAX_PROVIDER_TITLE_CHARACTERS,
  RawNewsCandidateSchema,
  ResearchSourceRecordSchema,
  type CollectionWindow,
  type NewsSourceAdapter,
  type RawNewsCandidate,
  type ResearchSourceInput,
  type ResearchSourceRecord,
} from "./types";

const POLYMARKET_ENDPOINT = "https://gamma-api.polymarket.com/markets";
const POLYMARKET_URL_POLICY = {
  allowedHosts: ["gamma-api.polymarket.com"],
  allowedPorts: [""],
  allowedPathPrefixes: ["/markets"],
} as const;

const ProbabilitySchema = z.number().finite().min(0).max(1);
const PolymarketMarketBaseSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().trim().min(1),
    slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    active: z.boolean().nullable(),
    closed: z.boolean().nullable(),
    archived: z.boolean().nullable(),
    acceptingOrders: z.boolean().nullable(),
    updatedAt: z.string().datetime().nullable(),
    endDate: z.string().datetime().nullable(),
    resolutionSource: z.string().url().nullable(),
  })
  .passthrough();
const NormalizedPolymarketMarketSchema =
  PolymarketMarketBaseSchema.extend({
    currentProbability: ProbabilitySchema.nullable(),
    priorProbability: ProbabilitySchema.nullable(),
    liquidity: z.number().finite().nonnegative().nullable(),
  });
const GammaPolymarketMarketSchema =
  PolymarketMarketBaseSchema.extend({
    outcomes: z.string().min(1).nullable(),
    outcomePrices: z.string().min(1).nullable(),
    oneDayPriceChange: z
      .number()
      .finite()
      .min(-1)
      .max(1)
      .nullable(),
    liquidity: z
      .union([
        z.string().trim().min(1),
        z.number().finite().nonnegative(),
      ])
      .nullable(),
  });
const PolymarketResponseSchema = z.array(z.unknown());
const PolymarketOptionsSchema = z.object({
  minimumLiquidity: z.number().finite().nonnegative(),
  minimumAbsoluteChange: z.number().finite().positive().max(1),
});

type PolymarketOptions = z.input<typeof PolymarketOptionsSchema>;
type NormalizedPolymarketMarket = z.output<
  typeof PolymarketMarketBaseSchema
> & {
  currentProbability: number;
  priorProbability: number;
  liquidity: number;
  updatedAt: string;
  resolutionSource: string;
};

function roundedProbability(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parseStringArray(value: string): string[] | null {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function eligibleMarket(
  market: z.output<typeof PolymarketMarketBaseSchema>,
): boolean {
  return (
    market.active === true &&
    market.closed === false &&
    market.archived === false &&
    market.acceptingOrders === true
  );
}

function normalizeMarket(input: unknown): NormalizedPolymarketMarket | null {
  const normalizedResult =
    NormalizedPolymarketMarketSchema.safeParse(input);
  if (normalizedResult.success) {
    const market = normalizedResult.data;
    if (
      !eligibleMarket(market) ||
      market.currentProbability === null ||
      market.priorProbability === null ||
      market.liquidity === null ||
      market.updatedAt === null ||
      market.resolutionSource === null
    ) {
      return null;
    }
    return {
      ...market,
      currentProbability: market.currentProbability,
      priorProbability: market.priorProbability,
      liquidity: market.liquidity,
      updatedAt: market.updatedAt,
      resolutionSource: market.resolutionSource,
    };
  }

  const gammaResult = GammaPolymarketMarketSchema.safeParse(input);
  if (!gammaResult.success || !eligibleMarket(gammaResult.data)) {
    return null;
  }
  const market = gammaResult.data;
  if (
    market.outcomes === null ||
    market.outcomePrices === null ||
    market.oneDayPriceChange === null ||
    market.liquidity === null ||
    market.updatedAt === null ||
    market.resolutionSource === null
  ) {
    return null;
  }
  const outcomes = parseStringArray(market.outcomes);
  const prices = parseStringArray(market.outcomePrices);
  if (
    outcomes === null ||
    prices === null ||
    outcomes.length === 0 ||
    outcomes.length !== prices.length
  ) {
    return null;
  }
  const yesIndexes = outcomes.flatMap((outcome, index) =>
    outcome.trim().toLowerCase() === "yes" ? [index] : [],
  );
  if (yesIndexes.length !== 1) return null;
  const yesIndex = yesIndexes[0];
  if (yesIndex === undefined) return null;
  const currentResult = ProbabilitySchema.safeParse(
    Number(prices[yesIndex]),
  );
  if (!currentResult.success) return null;
  const currentProbability = currentResult.data;
  const priorProbability = roundedProbability(
    currentProbability - market.oneDayPriceChange,
  );
  const priorResult = ProbabilitySchema.safeParse(priorProbability);
  const liquidity = Number(market.liquidity);
  if (
    !priorResult.success ||
    !Number.isFinite(liquidity) ||
    liquidity < 0
  ) {
    return null;
  }
  return {
    ...market,
    currentProbability,
    priorProbability: priorResult.data,
    liquidity,
    updatedAt: market.updatedAt,
    resolutionSource: market.resolutionSource,
  };
}

export class PolymarketAdapter implements NewsSourceAdapter {
  readonly sourceId: string;
  private readonly source: ResearchSourceRecord;
  private readonly options: z.output<typeof PolymarketOptionsSchema>;

  constructor(
    private readonly http: SourceHttpClient,
    source: ResearchSourceInput,
    options: PolymarketOptions,
  ) {
    this.source = ResearchSourceRecordSchema.parse(source);
    this.sourceId = this.source.id;
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
        urlPolicy: POLYMARKET_URL_POLICY,
      },
    );
    if (response.body === null) return [];
    const rawMarkets = PolymarketResponseSchema.parse(
      JSON.parse(response.body),
    );

    return rawMarkets.flatMap((rawMarket): RawNewsCandidate[] => {
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
      const question = boundProviderText(market.question, {
        maxCharacters: MAX_PROVIDER_TITLE_CHARACTERS,
      });
      if (question === null) return [];
      const signalQuestion = normalizedProviderSignalText(
        question,
        MAX_PROVIDER_TITLE_CHARACTERS,
      );
      if (signalQuestion === null) return [];
      const metadata = {
        currentProbability: market.currentProbability,
        priorProbability: market.priorProbability,
        absoluteChange,
        retrievedAt: response.retrievedAt,
        liquidity: market.liquidity,
        resolutionSource,
        resolvesAt: market.endDate,
        label: "Forecast, not fact",
      };

      return [
        RawNewsCandidateSchema.parse({
          kind: "forecast",
          sourceId: this.source.id,
          sourceName: this.source.canonicalName,
          sourceRole: "forecast",
          title: question,
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
          ...deriveNewsSignals({
            kind: "forecast",
            title: signalQuestion,
            abstract:
              `Probability moved from ${Math.round(
                market.priorProbability * 100,
              )}% to ${Math.round(market.currentProbability * 100)}%.`,
            content: null,
            originalUrl: marketUrl,
            sectionEligibility:
              this.source.sectionEligibility ?? ["forecast"],
            metadata,
            preferredSection:
              this.source.restrictions.preferredSection,
          }),
        }),
      ];
    });
  }
}
