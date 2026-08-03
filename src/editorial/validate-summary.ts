import { z } from "zod";

import {
  AccessLevelSchema,
  ItemKindSchema,
  SourceRefSchema,
  StructuredSummarySchema,
  type StructuredSummary,
} from "../contracts/editorial";

const NO_STRUCTURAL_SEPARATORS =
  /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        !Number.isFinite(next) ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function structurallySafe(value: string): boolean {
  return (
    NO_STRUCTURAL_SEPARATORS.test(value) &&
    !hasLoneSurrogate(value)
  );
}

function safeSingleLine(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine(structurallySafe, {
      message:
        "Control characters, line separators, and lone surrogates are not allowed.",
    });
}

const SafeSourceIdSchema = safeSingleLine(200);

const SafeUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    if (!structurallySafe(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Control characters, line separators, and lone surrogates are not allowed.",
      });
      return;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Source URLs must be credential-free HTTP(S) URLs.",
      });
    }
    if (credentialBearingUrl(url)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Source URLs must not contain credential-bearing query or fragment data.",
      });
    }
  });

const CREDENTIAL_VALUE_MARKER =
  /(?:^|[^a-z0-9])(?:api[-_.]?key|key|token|session|jwt|id[-_.]?token|access[-_.]?token|auth(?:orization)?|auth[-_.]?token|password|passwd|pwd|secret|credential(?:s)?|signature|signed|sig)(?:$|[^a-z0-9])/iu;

const CREDENTIAL_NAME_TOKENS = new Set([
  "auth",
  "authorization",
  "credential",
  "credentials",
  "jwt",
  "key",
  "passwd",
  "password",
  "pwd",
  "secret",
  "session",
  "sig",
  "signature",
  "signed",
  "token",
]);

const COMPACT_CREDENTIAL_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorizationtoken",
  "authtoken",
  "idtoken",
  "jwttoken",
  "sessionid",
]);

function credentialBearingParameterName(value: string): boolean {
  if (value.length > 256) return true;
  const normalized = value.normalize("NFKC");
  const tokens = normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  if (
    tokens.some((token) => CREDENTIAL_NAME_TOKENS.has(token))
  ) {
    return true;
  }
  const compact = normalized
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "");
  return COMPACT_CREDENTIAL_NAMES.has(compact);
}

function credentialMarkerInValue(value: string): boolean {
  return CREDENTIAL_VALUE_MARKER.test(value);
}

const MAX_QUERY_VALUE_LENGTH = 2_048;
const MAX_QUERY_VALUE_DECODE_DEPTH = 4;
const MAX_QUERY_VALUE_NODES = 32;

function decodedValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function assignmentValuesOrNull(value: string): string[] | null {
  const assignmentValues: string[] = [];
  for (const match of value.matchAll(
    /(?:^|[?&#;])([^=?&#;]*)=([^&#;]*)/gu,
  )) {
    const parameterName = match[1];
    if (parameterName === undefined || parameterName.length > 256) {
      return null;
    }
    if (credentialBearingParameterName(parameterName)) return null;
    const assignmentValue = match[2];
    if (assignmentValue !== undefined && assignmentValue.length > 0) {
      assignmentValues.push(assignmentValue);
      if (assignmentValues.length > MAX_QUERY_VALUE_NODES) return null;
    }
  }
  return assignmentValues;
}

function nestedUrlHasUnsafeData(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    );
  } catch {
    return false;
  }
}

function credentialBearingQueryValue(value: string): boolean {
  if (value.length > MAX_QUERY_VALUE_LENGTH) return true;
  const queue = [{ value, depth: 0 }];
  const queuedValues = new Set([value]);
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index]!;
    if (
      credentialMarkerInValue(candidate.value) ||
      nestedUrlHasUnsafeData(candidate.value)
    ) {
      return true;
    }
    const assignmentValues = assignmentValuesOrNull(
      candidate.value,
    );
    if (assignmentValues === null) return true;
    const decoded = decodedValue(candidate.value);
    const nestedValues =
      decoded !== null && decoded !== candidate.value
        ? [...assignmentValues, decoded]
        : assignmentValues;
    for (const nestedValue of nestedValues) {
      if (queuedValues.has(nestedValue)) continue;
      if (
        nestedValue.length > MAX_QUERY_VALUE_LENGTH ||
        candidate.depth === MAX_QUERY_VALUE_DECODE_DEPTH ||
        queue.length >= MAX_QUERY_VALUE_NODES
      ) {
        return true;
      }
      queuedValues.add(nestedValue);
      queue.push({
        value: nestedValue,
        depth: candidate.depth + 1,
      });
    }
  }
  return false;
}

function credentialBearingUrl(url: URL): boolean {
  if (url.hash.length > 0) return true;
  for (const [key, value] of url.searchParams) {
    if (
      credentialBearingParameterName(key) ||
      credentialBearingQueryValue(value)
    ) {
      return true;
    }
  }
  return false;
}

const SourcePacketExcerptSchema = z
  .object({
    number: z.number().int().positive(),
    text: safeSingleLine(4_000),
  })
  .strict();

const SourcePacketSourceSchema = z
  .object({
    sourceId: SafeSourceIdSchema,
    sourceName: safeSingleLine(200),
    evidenceKind: z.enum([
      "primary-research",
      "commentary",
      "news-evidence",
    ]),
    role: SourceRefSchema.shape.role,
    title: safeSingleLine(500),
    url: SafeUrlSchema,
    retrievedAt: z
      .string()
      .min(1)
      .max(40)
      .datetime()
      .refine(structurallySafe, {
        message:
          "Control characters, line separators, and lone surrogates are not allowed.",
      }),
    accessLevel: AccessLevelSchema,
    excerpts: z
      .array(SourcePacketExcerptSchema)
      .min(1)
      .max(8)
      .superRefine((excerpts, context) => {
        const numbers = new Set<number>();
        excerpts.forEach((excerpt, index) => {
          if (numbers.has(excerpt.number)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Excerpt numbers must be unique.",
              path: [index, "number"],
            });
          }
          numbers.add(excerpt.number);
        });
      }),
  })
  .strict();

export const SourcePacketSchema = z
  .object({
    itemKind: ItemKindSchema,
    sources: z
      .array(SourcePacketSourceSchema)
      .min(1)
      .max(12)
      .superRefine((sources, context) => {
        const sourceIds = new Set<string>();
        sources.forEach((source, index) => {
          if (sourceIds.has(source.sourceId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Source IDs must be unique.",
              path: [index, "sourceId"],
            });
          }
          sourceIds.add(source.sourceId);
        });
      }),
  })
  .strict();

export type SourcePacket = z.infer<typeof SourcePacketSchema>;

export type ValidationResult =
  | { ok: true; errors: readonly [] }
  | { ok: false; errors: readonly string[] };

export function serializeSourcePacket(packet: SourcePacket): string {
  const parsed = SourcePacketSchema.parse(packet);
  return [...parsed.sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map((source) =>
      [
        `source_id: ${source.sourceId}`,
        `source_name: ${source.sourceName}`,
        `evidence_kind: ${source.evidenceKind}`,
        `role: ${source.role}`,
        `title: ${source.title}`,
        `url: ${source.url}`,
        `retrieved_at: ${source.retrievedAt}`,
        `access_level: ${source.accessLevel}`,
        ...[...source.excerpts]
          .sort((left, right) => left.number - right.number)
          .map((excerpt) => `[${excerpt.number}] ${excerpt.text}`),
      ].join("\n"),
    )
    .join("\n\n");
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

export function claimEvidenceMatchesAllSources(
  evidenceExcerpt: string,
  sourceIds: readonly string[],
  packet: SourcePacket,
): boolean {
  const evidence = normalizedText(evidenceExcerpt);
  if (evidence.length === 0) return false;
  const sources = new Map(
    packet.sources.map((source) => [source.sourceId, source]),
  );
  return sourceIds.every((sourceId) =>
    sources.get(sourceId)?.excerpts.some((excerpt) =>
      normalizedText(excerpt.text).includes(evidence),
    ) ?? false,
  );
}

const StrictSummaryClaimSchema = StructuredSummarySchema.shape.claims.element
  .extend({
    sourceIds: z.array(SafeSourceIdSchema).min(1),
  })
  .strict();

const ProminentProvenanceEntrySchema = z
  .object({
    sourceIds: z.array(SafeSourceIdSchema).min(1),
    evidenceExcerpt: z
      .string()
      .min(1)
      .max(800)
      .refine((value) => normalizedText(value).length > 0, {
        message: "Evidence excerpt must contain non-whitespace text.",
      }),
  })
  .strict();

const ProminentProvenanceSchema = z
  .object({
    title: ProminentProvenanceEntrySchema,
    oneSentence: ProminentProvenanceEntrySchema,
    whyItMatters: ProminentProvenanceEntrySchema,
    uncertainty: ProminentProvenanceEntrySchema,
  })
  .strict();

const StrictGeneratedSummarySchema = StructuredSummarySchema.extend({
  claims: z.array(StrictSummaryClaimSchema).min(1),
  provenance: ProminentProvenanceSchema,
}).strict();

type PacketSource = SourcePacket["sources"][number];

function relevantAccessSources(
  sources: readonly PacketSource[],
): readonly PacketSource[] {
  const primarySources = sources.filter(
    (source) => source.role === "primary",
  );
  return primarySources.length > 0 ? primarySources : sources;
}

function primaryPacketSources(
  packet: SourcePacket,
): readonly PacketSource[] {
  return packet.sources.filter((source) => source.role === "primary");
}

function accessAuthorizationSources(
  packet: SourcePacket,
  citedSources: readonly PacketSource[],
  accessLevel: StructuredSummary["accessLevel"],
): readonly PacketSource[] {
  if (accessLevel === "full_text") {
    const primarySources = primaryPacketSources(packet);
    if (primarySources.length > 0) return primarySources;
  }
  return citedSources;
}

function allRelevantSourcesHaveAccess(
  sources: readonly PacketSource[],
  accessLevel: StructuredSummary["accessLevel"],
): boolean {
  if (accessLevel === "metadata") return sources.length > 0;
  const relevant = relevantAccessSources(sources);
  if (relevant.length === 0) return false;
  if (accessLevel === "secondary") {
    return sources.some(
      (source) =>
        source.accessLevel === "secondary" ||
        source.accessLevel === "full_text",
    );
  }
  if (accessLevel === "full_text") {
    return relevant.every(
      (source) => source.accessLevel === "full_text",
    );
  }
  return relevant.every(
    (source) =>
      source.accessLevel === accessLevel ||
      source.accessLevel === "full_text",
  );
}

function permitsAccessLevel(
  summary: StructuredSummary,
  packet: SourcePacket,
  citedSources: readonly PacketSource[],
): boolean {
  return allRelevantSourcesHaveAccess(
    accessAuthorizationSources(
      packet,
      citedSources,
      summary.accessLevel,
    ),
    summary.accessLevel,
  );
}

export function impliesFullTextAccess(value: string): boolean {
  const prose = normalizedText(value);
  const withoutHonestLimitations = prose
    .replace(
      /\b(?:we|the authors?|the researchers?)\s+(?:did not|didn't|could not|couldn't)\s+(?:access|read|review|obtain)\s+(?:the )?(?:full|complete)[- ](?:paper|text|manuscript)\b/g,
      "",
    )
    .replace(
      /\b(?:full|complete)[- ](?:paper|text|manuscript)\s+(?:(?:was|is|were|are)\s+)?(?:not (?:available|supplied|accessed|reviewed)|unavailable)\b/g,
      "",
    )
    .replace(
      /\bwithout (?:access to|reading|reviewing) (?:the )?(?:full|complete)[- ](?:paper|text|manuscript)\b/g,
      "",
    )
    .replace(
      /\bno (?:[a-z-]+ (?:or|and) )?(?:full|complete)[- ](?:paper|text|manuscript)\s+(?:was|is|were|are)\s+available\b/g,
      "",
    );
  return (
    /\b(?:full|complete)[- ](?:paper|text|manuscript)\b/.test(
      withoutHonestLimitations,
    ) ||
    /\b(?:complete|full) (?:methods|appendix|supplement)\b/.test(
      withoutHonestLimitations,
    )
  );
}

function proseAccessSources(
  packet: SourcePacket,
  matchingSources: readonly PacketSource[],
  citedSources: readonly PacketSource[],
): readonly PacketSource[] {
  const packetPrimarySources = primaryPacketSources(packet);
  if (packetPrimarySources.length > 0) return packetPrimarySources;
  const citedPrimarySources = citedSources.filter(
    (source) => source.role === "primary",
  );
  if (citedPrimarySources.length > 0) return citedPrimarySources;
  return matchingSources.length > 0 ? matchingSources : citedSources;
}

function trustedForecastRemainder(value: string): string | null {
  const normalized = normalizedText(value);
  const match =
    /^forecast\s*,\s*not fact(?:(?:\s*[.,:;!?\u2013\u2014-]\s*)|\s+|$)/u.exec(
      normalized,
    );
  if (match === null) return null;
  return normalized.slice(match[0].length).trim();
}

function extractivelySupports(
  assertion: string,
  evidenceExcerpt: string,
  citedSources: readonly PacketSource[],
  allowTrustedForecastLabel = false,
): boolean {
  const normalizedAssertion = normalizedText(assertion);
  const normalizedEvidence = normalizedText(evidenceExcerpt);
  if (
    normalizedAssertion.length === 0 ||
    normalizedEvidence.length === 0
  ) {
    return false;
  }
  const trustedRemainder = allowTrustedForecastLabel
    ? trustedForecastRemainder(assertion)
    : null;
  const supportedAssertion =
    trustedRemainder === null
      ? normalizedAssertion
      : trustedRemainder;
  if (supportedAssertion.length === 0) return true;
  if (
    normalizedEvidence.includes(supportedAssertion)
  ) {
    return true;
  }
  return citedSources.some((source) =>
    [source.title, ...source.excerpts.map((excerpt) => excerpt.text)]
      .map(normalizedText)
      .some((sourceText) =>
        sourceText.includes(supportedAssertion),
      ),
  );
}

function assertionSupportingSources(
  assertion: string,
  evidenceExcerpt: string,
  evidenceSources: readonly PacketSource[],
): readonly PacketSource[] {
  const normalizedAssertion = normalizedText(assertion);
  const normalizedEvidence = normalizedText(evidenceExcerpt);
  if (
    normalizedAssertion.length === 0 ||
    normalizedEvidence.length === 0
  ) return [];
  if (normalizedEvidence.includes(normalizedAssertion)) {
    return evidenceSources;
  }
  return evidenceSources.filter((source) =>
    [source.title, ...source.excerpts.map((excerpt) => excerpt.text)]
      .map(normalizedText)
      .some((sourceText) => sourceText.includes(normalizedAssertion))
  );
}

const COMMENTARY_ATTRIBUTION_VERB =
  /\b(?:argues|notes|suggests|critiques|interprets)\b/u;

function commentarySourceIsAttributed(
  claimText: string,
  source: PacketSource,
): boolean {
  const normalizedClaim = normalizedText(claimText);
  if (!COMMENTARY_ATTRIBUTION_VERB.test(normalizedClaim)) return false;
  return [source.sourceName, source.title]
    .map(normalizedText)
    .some((name) => name.length > 0 && normalizedClaim.includes(name));
}

function hasResearchClaimAuthority(
  claimText: string,
  citedSources: readonly PacketSource[],
): boolean {
  if (
    citedSources.some((source) => source.evidenceKind === "primary-research")
  ) {
    return true;
  }
  return citedSources.length > 0 &&
    citedSources.every(
      (source) =>
        source.evidenceKind === "commentary" &&
        commentarySourceIsAttributed(claimText, source),
    );
}

export function validateSummary(
  summary: unknown,
  packet: SourcePacket,
): ValidationResult {
  const parsed = StrictGeneratedSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        ...new Set(
          parsed.error.issues.map(
            (issue) =>
              `SCHEMA_INVALID:${issue.path.join(".") || "root"}`,
          ),
        ),
      ],
    };
  }

  const errors: string[] = [];
  const sources = new Map(
    packet.sources.map((source) => [source.sourceId, source]),
  );
  const allCitedSources: PacketSource[] = [];

  parsed.data.claims.forEach((claim, claimIndex) => {
    const citedSources = claim.sourceIds.flatMap((sourceId) => {
      const source = sources.get(sourceId);
      if (source === undefined) {
        errors.push(
          `UNKNOWN_SOURCE:${encodeURIComponent(sourceId).slice(0, 600)}`,
        );
        return [];
      }
      allCitedSources.push(source);
      return [source];
    });
    const evidence = normalizedText(claim.evidenceExcerpt);
    if (evidence.length === 0) {
      errors.push(`EMPTY_EVIDENCE:${claimIndex}`);
      return;
    }
    const evidenceSources = citedSources.filter((source) =>
      source.excerpts.some((excerpt) =>
        normalizedText(excerpt.text).includes(evidence),
      ),
    );
    if (evidenceSources.length === 0) {
      errors.push(`EVIDENCE_NOT_FOUND:${claimIndex}`);
    }
    if (!claimEvidenceMatchesAllSources(
      claim.evidenceExcerpt,
      claim.sourceIds,
      packet,
    )) {
      errors.push("CLAIM_EVIDENCE_NOT_EXACT");
    }
    if (
      !extractivelySupports(
        claim.text,
        claim.evidenceExcerpt,
        citedSources,
      )
    ) {
      errors.push(`UNGROUNDED_CLAIM:${claimIndex}`);
    }
    if (
      (packet.itemKind === "paper" || packet.itemKind === "blog") &&
      evidenceSources.length > 0 &&
      !hasResearchClaimAuthority(
        claim.text,
        assertionSupportingSources(
          claim.text,
          claim.evidenceExcerpt,
          evidenceSources,
        ),
      )
    ) {
      errors.push(`PRIMARY_RESEARCH_SOURCE_REQUIRED:${claimIndex}`);
    }
    if (
      (impliesFullTextAccess(claim.text) ||
        impliesFullTextAccess(claim.evidenceExcerpt)) &&
      !allRelevantSourcesHaveAccess(
        accessAuthorizationSources(
          packet,
          citedSources,
          "full_text",
        ),
        "full_text",
      )
    ) {
      errors.push("ACCESS_LEVEL_OVERCLAIM");
    }
  });

  if (!permitsAccessLevel(parsed.data, packet, allCitedSources)) {
    errors.push("ACCESS_LEVEL_OVERCLAIM");
  }

  const forecast =
    packet.itemKind === "forecast" ||
    packet.sources.some((source) => source.role === "forecast");

  (
    [
      ["title", parsed.data.title],
      ["oneSentence", parsed.data.oneSentence],
      ["whyItMatters", parsed.data.whyItMatters],
      ["uncertainty", parsed.data.uncertainty],
    ] as const
  ).forEach(([field, prose]) => {
    const provenance = parsed.data.provenance[field];
    const citedSources = provenance.sourceIds.flatMap((sourceId) => {
      const source = sources.get(sourceId);
      if (source === undefined) {
        errors.push(
          `UNKNOWN_SOURCE:${encodeURIComponent(sourceId).slice(0, 600)}`,
        );
        return [];
      }
      return [source];
    });
    const normalizedEvidence = normalizedText(
      provenance.evidenceExcerpt,
    );
    const evidenceSources =
      normalizedEvidence.length === 0
        ? []
        : citedSources.filter((source) =>
            source.excerpts.some((excerpt) =>
              normalizedText(excerpt.text).includes(
                normalizedEvidence,
              ),
            ),
          );
    if (
      evidenceSources.length === 0 ||
      !extractivelySupports(
        prose,
        provenance.evidenceExcerpt,
        citedSources,
        forecast,
      )
    ) {
      errors.push(`UNGROUNDED_PROSE:${field}`);
    }
    if (
      impliesFullTextAccess(prose) &&
      !allRelevantSourcesHaveAccess(
        proseAccessSources(packet, evidenceSources, citedSources),
        "full_text",
      )
    ) {
      errors.push("ACCESS_LEVEL_OVERCLAIM");
    }
  });

  if (normalizedText(parsed.data.uncertainty).length === 0) {
    errors.push("EMPTY_UNCERTAINTY");
  }

  if (forecast) {
    const prose = normalizedText(
      [
        parsed.data.title,
        parsed.data.oneSentence,
        parsed.data.whyItMatters,
        parsed.data.uncertainty,
      ].join(" "),
    );
    if (
      !/\bforecast\s*,\s*not (?:a )?fact\b/.test(prose) ||
      /\bnot a forecast\b/.test(prose)
    ) {
      errors.push("FORECAST_LABEL_MISSING");
    }
  }

  const uniqueErrors = [...new Set(errors)];
  return uniqueErrors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, errors: uniqueErrors };
}
