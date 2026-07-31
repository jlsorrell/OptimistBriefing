function safelyDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function normalizeDoi(value: string): string | null {
  let normalized = value.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    normalized = normalized
      .replace(/^doi:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    const decoded = safelyDecode(normalized);
    if (decoded === null) {
      return null;
    }
    normalized = decoded.trim();
  }
  normalized = normalized.toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(normalized) ? normalized : null;
}

export function normalizeArxivIdentifier(value: string): string | null {
  const decoded = safelyDecode(value.trim());
  if (decoded === null) {
    return null;
  }
  let normalized = decoded
    .replace(/^arxiv:\s*/i, "")
    .replace(
      /^(?:https?:\/\/)?(?:export\.)?arxiv\.org\/(?:abs|html|pdf)\//i,
      "",
    )
    .replace(/[?#].*$/, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
  const modern = normalized.match(/^(\d{4}\.\d{4,5})$/);
  if (modern?.[1] !== undefined) {
    return `arXiv:${modern[1]}`;
  }
  normalized = normalized.toLowerCase();
  const legacy = normalized.match(/^([a-z.-]+\/\d{7})$/);
  return legacy?.[1] === undefined ? null : `arXiv:${legacy[1]}`;
}
