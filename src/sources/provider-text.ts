export const MAX_PROVIDER_TEXT_INPUT_CHARACTERS = 100_000;
const MAX_ENTITY_DECODE_PASSES = 2;
const ENTITY = /&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi;
const RESIDUAL_ENCODED_ANGLE =
  /&(?:lt|gt|#0{0,5}(?:60|62)|#0{0,2}(?:65308|65310)|#x0{0,4}(?:3c|3e)|#x0{0,2}(?:ff1c|ff1e));/gi;
const RESIDUAL_ENCODED_OPEN_ANGLE =
  /^&(?:lt|#0{0,5}60|#0{0,2}65308|#x0{0,4}3c|#x0{0,2}ff1c);$/i;
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
  let decoded = truncateProviderTextAtCodePointBoundary(
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

function normalizeAndDecodeProviderText(value: string): string {
  let decoded = truncateProviderTextAtCodePointBoundary(
    value,
    MAX_PROVIDER_TEXT_INPUT_CHARACTERS,
  );
  // Compatibility folding is part of each of the existing two decode passes,
  // so newly formed entity syntax consumes the same fixed pass budget. A final
  // fold makes later tag stripping see any ASCII syntax formed on pass two.
  for (let pass = 0; pass < MAX_ENTITY_DECODE_PASSES; pass += 1) {
    const compatible = decoded.normalize("NFKC");
    const next = decodePass(compatible);
    if (compatible === decoded && next === compatible) break;
    decoded = next;
  }
  return decoded.normalize("NFKC");
}

function isAsciiLetter(codeUnit: number): boolean {
  return (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a);
}

function isResidualTagNameCharacter(codeUnit: number): boolean {
  return isAsciiLetter(codeUnit) ||
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    codeUnit === 0x3a || codeUnit === 0x2e ||
    codeUnit === 0x5f || codeUnit === 0x2d;
}

function isConservativeResidualTagToken(value: string): boolean {
  let index = value.startsWith("/") ? 1 : 0;
  const closing = index === 1;
  if (index >= value.length || !isAsciiLetter(value.charCodeAt(index))) {
    return false;
  }
  index += 1;
  while (
    index < value.length &&
    isResidualTagNameCharacter(value.charCodeAt(index))
  ) {
    index += 1;
  }
  if (index === value.length) return true;
  return !closing && index === value.length - 1 && value[index] === "/";
}

function stripResidualEncodedTags(value: string): string {
  let plain = "";
  let cursor = 0;
  let openStart: number | null = null;
  let openEnd = 0;
  let nested = false;
  for (const match of value.matchAll(RESIDUAL_ENCODED_ANGLE)) {
    const index = match.index;
    const token = match[0];
    const opening = RESIDUAL_ENCODED_OPEN_ANGLE.test(token);
    if (nested) {
      if (!opening) nested = false;
      continue;
    }
    if (openStart !== null) {
      if (opening) {
        openStart = null;
        nested = true;
        continue;
      }
      if (isConservativeResidualTagToken(value.slice(openEnd, index))) {
        plain += `${value.slice(cursor, openStart)} `;
        cursor = index + token.length;
      }
      openStart = null;
      continue;
    }
    if (opening) {
      openStart = index;
      openEnd = index + token.length;
    }
  }
  return plain + value.slice(cursor);
}

export type ProviderTextOptions = {
  stripHtml?: boolean;
  maxCharacters?: number;
};

export type ProviderTextNormalizationResult = {
  value: string | null;
  truncated: boolean;
};

export function truncateProviderTextAtCodePointBoundary(
  value: string,
  maximum: number,
): string {
  if (maximum <= 0) return "";
  const inspectedLength = Math.min(value.length, maximum);
  const safe: string[] = [];
  for (let index = 0; index < inspectedLength; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= inspectedLength) continue;
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) continue;
      safe.push(String.fromCharCode(codeUnit, following));
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) continue;
    safe.push(String.fromCharCode(codeUnit));
  }
  return safe.join("");
}

export function normalizeProviderTextDetailed(
  value: string | null | undefined,
  options: ProviderTextOptions = {},
): ProviderTextNormalizationResult {
  if (value == null) return { value: null, truncated: false };
  const maximum = options.maxCharacters ?? MAX_PROVIDER_TEXT_INPUT_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 0 ||
      maximum > MAX_PROVIDER_TEXT_INPUT_CHARACTERS) {
    throw new RangeError("Provider text limit is outside the safe bound.");
  }
  const decoded = normalizeAndDecodeProviderText(value);
  const plain = options.stripHtml === true
    ? decoded.replace(/<[^>]+>/g, " ")
    : decoded;
  const normalized = plain.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return {
      value: null,
      truncated: value.length > MAX_PROVIDER_TEXT_INPUT_CHARACTERS,
    };
  }
  return {
    value: truncateProviderTextAtCodePointBoundary(normalized, maximum),
    truncated:
      value.length > MAX_PROVIDER_TEXT_INPUT_CHARACTERS ||
      normalized.length > maximum,
  };
}

export function boundProviderTextDetailed(
  value: string | null | undefined,
  options: ProviderTextOptions = {},
): ProviderTextNormalizationResult {
  if (value == null) return { value: null, truncated: false };
  const maximum = options.maxCharacters ?? MAX_PROVIDER_TEXT_INPUT_CHARACTERS;
  if (!Number.isSafeInteger(maximum) || maximum < 0 ||
      maximum > MAX_PROVIDER_TEXT_INPUT_CHARACTERS) {
    throw new RangeError("Provider text limit is outside the safe bound.");
  }
  const inspected = truncateProviderTextAtCodePointBoundary(
    value,
    MAX_PROVIDER_TEXT_INPUT_CHARACTERS,
  );
  const plain = options.stripHtml === true
    ? inspected.replace(/<[^>]+>/g, " ")
    : inspected;
  const normalized = plain.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return {
      value: null,
      truncated: value.length > MAX_PROVIDER_TEXT_INPUT_CHARACTERS,
    };
  }
  return {
    value: truncateProviderTextAtCodePointBoundary(normalized, maximum),
    truncated:
      value.length > MAX_PROVIDER_TEXT_INPUT_CHARACTERS ||
      normalized.length > maximum,
  };
}

export function boundProviderText(
  value: string | null | undefined,
  options: ProviderTextOptions = {},
): string | null {
  return boundProviderTextDetailed(value, options).value;
}

export function normalizeProviderText(
  value: string | null | undefined,
  options: ProviderTextOptions = {},
): string | null {
  return normalizeProviderTextDetailed(value, options).value;
}

export function normalizedProviderSignalText(
  value: string | null | undefined,
  maxCharacters = MAX_PROVIDER_TEXT_INPUT_CHARACTERS,
): string | null {
  const normalized = normalizeProviderText(value, {
    stripHtml: true,
    maxCharacters,
  });
  if (normalized === null) return null;
  const plain = stripResidualEncodedTags(normalized)
    .replace(/\s+/g, " ")
    .trim();
  return plain.length === 0 ? null : plain;
}
