import type { ResearchSourceInput } from "./types";

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_USER_AGENT =
  "OptimistBriefing/1.0 (+https://optimistindustries.com)";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type Sleep = (milliseconds: number) => Promise<void>;

type SourceHttpClientOptions = {
  fetch?: FetchLike;
  userAgent?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  sleep?: Sleep;
  now?: () => Date;
};

type RequestOptions = {
  method?: "GET" | "POST";
  headers?: HeadersInit;
  body?: string;
  useValidators?: boolean;
};

type Validators = {
  etag?: string;
  lastModified?: string;
};

export type SourceHttpResponse = {
  status: number;
  body: string | null;
  notModified: boolean;
  retrievedAt: string;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
};

export class SourceFetchError extends Error {
  readonly sourceId: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly code: "SOURCE_FETCH_FAILED";

  constructor(input: {
    sourceId: string;
    status: number | null;
    retryable: boolean;
    reason: string;
  }) {
    super(
      `Source fetch failed for ${input.sourceId}: ${input.reason}` +
        (input.status === null ? "" : ` (HTTP ${input.status})`),
    );
    this.name = "SourceFetchError";
    this.code = "SOURCE_FETCH_FAILED";
    this.sourceId = input.sourceId;
    this.status = input.status;
    this.retryable = input.retryable;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      sourceId: this.sourceId,
      status: this.status,
      retryable: this.retryable,
      message: this.message,
    };
  }
}

function systemSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function retryDelayMilliseconds(
  retryAfter: string | null,
  attempt: number,
  now: Date,
): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 60_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - now.getTime()), 60_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  sourceId: string,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    await response.body?.cancel();
    throw new SourceFetchError({
      sourceId,
      status: response.status,
      retryable: false,
      reason: `response exceeds ${maxBytes} bytes`,
    });
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let body = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      byteCount += part.value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel();
        throw new SourceFetchError({
          sourceId,
          status: response.status,
          retryable: false,
          reason: `response exceeds ${maxBytes} bytes`,
        });
      }
      body += decoder.decode(part.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class SourceHttpClient {
  private readonly fetch: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRetries: number;
  private readonly sleep: Sleep;
  private readonly now: () => Date;
  private readonly validators = new Map<string, Validators>();

  constructor(options: SourceHttpClientOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Source request timeout must be positive.");
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw new RangeError("Source response limit must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 5
    ) {
      throw new RangeError("Source retry count must be an integer from 0 to 5.");
    }
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxRetries = maxRetries;
    this.sleep = options.sleep ?? systemSleep;
    this.now = options.now ?? (() => new Date());
  }

  get(
    source: ResearchSourceInput,
    url: string,
    options: { headers?: HeadersInit } = {},
  ): Promise<SourceHttpResponse> {
    return this.request(source, url, {
      method: "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      useValidators: true,
    });
  }

  postJson(
    source: ResearchSourceInput,
    url: string,
    payload: unknown,
    options: { headers?: HeadersInit } = {},
  ): Promise<SourceHttpResponse> {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    return this.request(source, url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      useValidators: false,
    });
  }

  private async request(
    source: ResearchSourceInput,
    url: string,
    options: RequestOptions,
  ): Promise<SourceHttpResponse> {
    const validatorKey = `${source.id}:${url}`;
    const method = options.method ?? "GET";

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const headers = new Headers(options.headers);
      headers.set("user-agent", this.userAgent);
      if (options.useValidators === true) {
        const validators = this.validators.get(validatorKey);
        if (validators?.etag !== undefined) {
          headers.set("if-none-match", validators.etag);
        }
        if (validators?.lastModified !== undefined) {
          headers.set("if-modified-since", validators.lastModified);
        }
      }

      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort(new Error("source request timed out"));
      }, this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          signal: abortController.signal,
          ...(options.body === undefined ? {} : { body: options.body }),
        });
      } catch {
        clearTimeout(timeout);
        throw new SourceFetchError({
          sourceId: source.id,
          status: null,
          retryable: true,
          reason: "network error or timeout",
        });
      }

      const retrievedAt = this.now().toISOString();
      if (response.status === 304 && options.useValidators === true) {
        clearTimeout(timeout);
        await response.body?.cancel();
        return {
          status: 304,
          body: null,
          notModified: true,
          retrievedAt,
          contentType: response.headers.get("content-type"),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
      }

      if (!response.ok) {
        const retryable = RETRYABLE_STATUSES.has(response.status);
        if (retryable && attempt < this.maxRetries) {
          const delay = retryDelayMilliseconds(
            response.headers.get("retry-after"),
            attempt,
            this.now(),
          );
          clearTimeout(timeout);
          await response.body?.cancel();
          await this.sleep(delay);
          continue;
        }
        clearTimeout(timeout);
        await response.body?.cancel();
        throw new SourceFetchError({
          sourceId: source.id,
          status: response.status,
          retryable,
          reason: retryable ? "retry limit exhausted" : "upstream rejected request",
        });
      }

      let body: string;
      try {
        body = await readBoundedBody(
          response,
          this.maxResponseBytes,
          source.id,
        );
      } catch (error) {
        if (error instanceof SourceFetchError) {
          throw error;
        }
        throw new SourceFetchError({
          sourceId: source.id,
          status: response.status,
          retryable: true,
          reason: "network error or timeout while reading response",
        });
      } finally {
        clearTimeout(timeout);
      }
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      if (
        options.useValidators === true &&
        (etag !== null || lastModified !== null)
      ) {
        this.validators.set(validatorKey, {
          ...(etag === null ? {} : { etag }),
          ...(lastModified === null ? {} : { lastModified }),
        });
      }

      return {
        status: response.status,
        body,
        notModified: false,
        retrievedAt,
        contentType: response.headers.get("content-type"),
        etag,
        lastModified,
      };
    }

    throw new SourceFetchError({
      sourceId: source.id,
      status: null,
      retryable: false,
      reason: "unreachable retry state",
    });
  }
}
