export type OutboundUrlPolicy = {
  allowedHosts?: readonly string[];
  allowedPorts?: readonly string[];
  allowedPathPrefixes?: readonly string[];
};

export class UnsafeOutboundUrlError extends Error {
  constructor(reason: string) {
    super(`Unsafe outbound URL: ${reason}`);
    this.name = "UnsafeOutboundUrlError";
  }
}

function ipv4IsPrivateOrReserved(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return false;
  }
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet > 255)
  ) {
    return true;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function ipv6IsPrivateOrReserved(hostname: string): boolean {
  const unbracketed = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!unbracketed.includes(":")) {
    return false;
  }
  return (
    unbracketed === "::" ||
    unbracketed === "::1" ||
    unbracketed.startsWith("fc") ||
    unbracketed.startsWith("fd") ||
    /^fe[89ab]/.test(unbracketed) ||
    unbracketed.startsWith("::ffff:")
  );
}

function hostnameIsLocal(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".lan") ||
    ipv4IsPrivateOrReserved(normalized) ||
    ipv6IsPrivateOrReserved(normalized)
  );
}

export function assertSafeOutboundUrl(
  value: string | URL,
  policy: OutboundUrlPolicy = {},
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeOutboundUrlError("invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeOutboundUrlError("HTTPS is required");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeOutboundUrlError("userinfo is forbidden");
  }
  if (hostnameIsLocal(url.hostname)) {
    throw new UnsafeOutboundUrlError("local or private targets are forbidden");
  }
  if (
    policy.allowedHosts !== undefined &&
    !policy.allowedHosts.some(
      (host) => url.hostname.toLowerCase() === host.toLowerCase(),
    )
  ) {
    throw new UnsafeOutboundUrlError("host is outside the source allowlist");
  }
  if (
    policy.allowedPorts !== undefined &&
    !policy.allowedPorts.includes(url.port)
  ) {
    throw new UnsafeOutboundUrlError("port is outside the source allowlist");
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new UnsafeOutboundUrlError("path has invalid encoding");
  }
  if (
    policy.allowedPathPrefixes !== undefined &&
    !policy.allowedPathPrefixes.some((prefix) =>
      decodedPath.startsWith(prefix),
    )
  ) {
    throw new UnsafeOutboundUrlError("path is outside the source allowlist");
  }
  return url;
}
