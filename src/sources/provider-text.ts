export const MAX_PROVIDER_TEXT_INPUT_CHARACTERS = 100_000;
const MAX_ENTITY_DECODE_PASSES = 2;
const ENTITY = /&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi;
const NAMED = new Map<string, string>([
  ["amp", "&"], ["quot", "\""], ["apos", "'"],
  ["lt", "<"], ["gt", ">"], ["nbsp", " "],
]);

function safeScalar(value: number): boolean {
  return Number.isSafeInteger(value) &&
    value > 0 && value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff) &&
    !(value <= 0x1f || (value >= 0x7f && value <= 0x9f));
}

function decodePass(value: string): string {
  return value.replace(ENTITY, (match, decimal, hexadecimal, named) => {
    if (typeof named === "string") {
      return NAMED.get(named.toLowerCase()) ?? match;
    }
    const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
    return safeScalar(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

export function decodeProviderTextEntities(value: string): string {
  let decoded = truncateAtCodePointBoundary(
    value,
    MAX_PROVIDER_TEXT_INPUT_CHARACTERS,
  );
  for (let pass = 0; pass < MAX_ENTITY_DECODE_PASSES; pass += 1) {
    const next = decodePass(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

export type ProviderTextOptions = {
  stripHtml?: boolean;
  maxCharacters?: number;
};

function truncateAtCodePointBoundary(
  value: string,
  maximum: number,
): string {
  if (value.length <= maximum) return value;
  if (maximum === 0) return "";
  const finalCodeUnit = value.charCodeAt(maximum - 1);
  const end = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    ? maximum - 1
    : maximum;
  return value.slice(0, end);
}

export function normalizeProviderText(
  value: string | null | undefined,
  options: ProviderTextOptions = {},
): string | null {
  if (value == null) return null;
  const maximum = options.maxCharacters ?? MAX_PROVIDER_TEXT_INPUT_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 0 ||
      maximum > MAX_PROVIDER_TEXT_INPUT_CHARACTERS) {
    throw new RangeError("Provider text limit is outside the safe bound.");
  }
  const decoded = decodeProviderTextEntities(value);
  const plain = options.stripHtml === true
    ? decoded.replace(/<[^>]+>/g, " ")
    : decoded;
  const normalized = plain.normalize("NFKC").replace(/\s+/g, " ").trim();
  return normalized.length === 0
    ? null
    : truncateAtCodePointBoundary(normalized, maximum);
}
