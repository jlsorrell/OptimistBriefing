import type { ResearchSourceInput } from "./types";
import {
  assertSafeOutboundUrl,
  UnsafeOutboundUrlError,
  type OutboundUrlPolicy,
} from "./outbound-url";
import type {
  ProviderRequestAdmission,
  ProviderRequestAdmissionLease,
} from "./provider-scheduler";

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_USER_AGENT =
  "OptimistBriefing/1.0 (+https://optimistindustries.com)";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

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
  requestAdmission?: ProviderRequestAdmission;
};

export type SourceRequestOptions = {
  headers?: HeadersInit;
  useValidators?: boolean;
  urlPolicy?: OutboundUrlPolicy;
  sensitiveQueryParameters?: readonly string[];
  maxRetries?: number;
};

type RequestOptions = SourceRequestOptions & {
  method?: "GET" | "POST";
  body?: string;
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
  finalUrl: string;
};

export type SourceFetchFailureKind = "policy" | "transport" | "timeout";

export class SourceFetchError extends Error {
  readonly sourceId: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly failureKind: SourceFetchFailureKind;
  readonly code: "SOURCE_FETCH_FAILED";

  constructor(input: {
    sourceId: string;
    status: number | null;
    retryable: boolean;
    failureKind: SourceFetchFailureKind;
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
    this.failureKind = input.failureKind;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      sourceId: this.sourceId,
      status: this.status,
      retryable: this.retryable,
      failureKind: this.failureKind,
      message: this.message,
    };
  }
}

function systemSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function settleWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;

  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(
      signal.reason ?? new Error("source request timed out"),
    );
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    if (rejectOnAbort !== undefined) {
      signal.removeEventListener("abort", rejectOnAbort);
    }
  }
}

async function cancelResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (response.body === null) return;
  await settleWithAbort(() => response.body!.cancel(), signal);
}

function responseBodyFailure(
  sourceId: string,
  status: number,
  signal: AbortSignal,
): SourceFetchError {
  return new SourceFetchError({
    sourceId,
    status,
    retryable: true,
    failureKind: signal.aborted ? "timeout" : "transport",
    reason: signal.aborted
      ? "request timed out while reading response"
      : "network error while reading response",
  });
}

const passThroughAdmission: ProviderRequestAdmission = Object.freeze({
  acquire: async () => ({ release: () => undefined }),
});

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

function redactedUrl(input: URL, names: readonly string[]): string {
  const output = new URL(input);
  for (const name of names) {
    if (output.searchParams.has(name)) {
      output.searchParams.set(name, "REDACTED");
    }
  }
  return output.toString();
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  sourceId: string,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    try {
      await cancelResponseBody(response, signal);
    } catch {
      // The known non-retryable response-size rejection remains authoritative.
    }
    throw new SourceFetchError({
      sourceId,
      status: response.status,
      retryable: false,
      failureKind: "transport",
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
      const part = await settleWithAbort(() => reader.read(), signal);
      if (part.done) {
        break;
      }
      byteCount += part.value.byteLength;
      if (byteCount > maxBytes) {
        try {
          await settleWithAbort(() => reader.cancel(), signal);
        } catch {
          // The known non-retryable response-size rejection remains authoritative.
        }
        throw new SourceFetchError({
          sourceId,
          status: response.status,
          retryable: false,
          failureKind: "transport",
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
  private readonly requestAdmission: ProviderRequestAdmission;
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
    this.requestAdmission = options.requestAdmission ?? passThroughAdmission;
  }

  get(
    source: ResearchSourceInput,
    url: string,
    options: SourceRequestOptions = {},
  ): Promise<SourceHttpResponse> {
    return this.request(source, url, {
      method: "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      useValidators: options.useValidators ?? true,
      ...(options.urlPolicy === undefined
        ? {}
        : { urlPolicy: options.urlPolicy }),
      ...(options.sensitiveQueryParameters === undefined
        ? {}
        : { sensitiveQueryParameters: options.sensitiveQueryParameters }),
      ...(options.maxRetries === undefined
        ? {}
        : { maxRetries: options.maxRetries }),
    });
  }

  postJson(
    source: ResearchSourceInput,
    url: string,
    payload: unknown,
    options: {
      headers?: HeadersInit;
      urlPolicy?: OutboundUrlPolicy;
    } = {},
  ): Promise<SourceHttpResponse> {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    return this.request(source, url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      useValidators: false,
      ...(options.urlPolicy === undefined
        ? {}
        : { urlPolicy: options.urlPolicy }),
    });
  }

  private async request(
    source: ResearchSourceInput,
    url: string,
    options: RequestOptions,
  ): Promise<SourceHttpResponse> {
    const maxRetries = options.maxRetries ?? this.maxRetries;
    if (
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 5
    ) {
      throw new RangeError("Source retry count must be an integer from 0 to 5.");
    }
    let initialUrl: URL;
    try {
      initialUrl = assertSafeOutboundUrl(url, options.urlPolicy);
    } catch (error) {
      if (error instanceof UnsafeOutboundUrlError) {
        throw new SourceFetchError({
          sourceId: source.id,
          status: null,
          retryable: false,
          failureKind: "policy",
          reason: "unsafe outbound URL",
        });
      }
      throw error;
    }
    const sensitiveNames = options.sensitiveQueryParameters ?? [];
    const validatorKey = `${source.id}:${redactedUrl(initialUrl, sensitiveNames)}`;
    const method = options.method ?? "GET";

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
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

      const firstAdmission = await this.requestAdmission.acquire(source.id);
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort(new Error("source request timed out"));
      }, this.timeoutMs);
      let response: Response;
      let finalUrl = initialUrl;
      let responseAdmission: ProviderRequestAdmissionLease | null = null;
      try {
        let redirectCount = 0;
        let requestHeaders = headers;
        let pendingAdmission: ProviderRequestAdmissionLease | null =
          firstAdmission;
        while (true) {
          const admission = pendingAdmission ??
            await this.requestAdmission.acquire(source.id);
          pendingAdmission = null;
          let retainAdmission = false;
          try {
            response = await this.fetch(finalUrl.toString(), {
              method,
              headers: requestHeaders,
              signal: abortController.signal,
              redirect: "manual",
              ...(options.body === undefined ? {} : { body: options.body }),
            });
            if (response.redirected) {
              try {
                await cancelResponseBody(response, abortController.signal);
              } catch {
                // The known policy rejection remains authoritative.
              }
              throw new SourceFetchError({
                sourceId: source.id,
                status: response.status,
                retryable: false,
                failureKind: "policy",
                reason: "automatic redirect rejected",
              });
            }
            if (response.url !== "") {
              try {
                finalUrl = assertSafeOutboundUrl(
                  response.url,
                  options.urlPolicy,
                );
              } catch (error) {
                try {
                  await cancelResponseBody(response, abortController.signal);
                } catch {
                  // The known response-URL policy rejection remains authoritative.
                }
                throw error;
              }
            }
            if (!REDIRECT_STATUSES.has(response.status)) {
              responseAdmission = admission;
              retainAdmission = true;
              break;
            }
            const location = response.headers.get("location");
            if (
              method !== "GET" ||
              location === null ||
              redirectCount >= MAX_REDIRECTS
            ) {
              try {
                await cancelResponseBody(response, abortController.signal);
              } catch {
                // The known non-retryable redirect rejection remains authoritative.
              }
              throw new SourceFetchError({
                sourceId: source.id,
                status: response.status,
                retryable: false,
                failureKind: "transport",
                reason: "redirect rejected",
              });
            }
            const previousOrigin = finalUrl.origin;
            let nextUrl: URL;
            try {
              let resolvedLocation: URL;
              try {
                resolvedLocation = new URL(location, finalUrl);
              } catch {
                throw new UnsafeOutboundUrlError("invalid redirect location");
              }
              nextUrl = assertSafeOutboundUrl(
                resolvedLocation,
                options.urlPolicy,
              );
            } catch (error) {
              try {
                await cancelResponseBody(response, abortController.signal);
              } catch {
                // The known redirect-URL policy rejection remains authoritative.
              }
              throw error;
            }
            if (
              nextUrl.origin !== previousOrigin &&
              sensitiveNames.some((name) => finalUrl.searchParams.has(name))
            ) {
              try {
                await cancelResponseBody(response, abortController.signal);
              } catch {
                // The known policy rejection remains authoritative.
              }
              throw new SourceFetchError({
                sourceId: source.id,
                status: response.status,
                retryable: false,
                failureKind: "policy",
                reason: "sensitive query redirect rejected",
              });
            }
            await cancelResponseBody(response, abortController.signal);
            redirectCount += 1;
            if (nextUrl.origin !== previousOrigin) {
              requestHeaders = new Headers();
              for (const name of ["accept", "accept-language", "user-agent"]) {
                const value = headers.get(name);
                if (value !== null) {
                  requestHeaders.set(name, value);
                }
              }
            }
            finalUrl = nextUrl;
          } finally {
            if (!retainAdmission) admission.release();
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        let failure: SourceFetchError;
        if (error instanceof SourceFetchError) {
          failure = error;
        } else if (error instanceof UnsafeOutboundUrlError) {
          failure = new SourceFetchError({
            sourceId: source.id,
            status: null,
            retryable: false,
            failureKind: "policy",
            reason: "unsafe redirect URL",
          });
        } else {
          failure = new SourceFetchError({
            sourceId: source.id,
            status: null,
            retryable: true,
            failureKind: abortController.signal.aborted
              ? "timeout"
              : "transport",
            reason: abortController.signal.aborted
              ? "request timed out"
              : "network error",
          });
        }
        if (failure.retryable && attempt < maxRetries) {
          await this.sleep(retryDelayMilliseconds(null, attempt, this.now()));
          continue;
        }
        throw failure;
      }

      const retrievedAt = this.now().toISOString();
      if (response.status === 304 && options.useValidators === true) {
        let cancellationFailure: SourceFetchError | null = null;
        try {
          await cancelResponseBody(response, abortController.signal);
        } catch {
          cancellationFailure = responseBodyFailure(
            source.id,
            response.status,
            abortController.signal,
          );
        } finally {
          clearTimeout(timeout);
          responseAdmission?.release();
        }
        if (cancellationFailure !== null) {
          if (attempt < maxRetries) {
            await this.sleep(
              retryDelayMilliseconds(null, attempt, this.now()),
            );
            continue;
          }
          throw cancellationFailure;
        }
        return {
          status: 304,
          body: null,
          notModified: true,
          retrievedAt,
          contentType: response.headers.get("content-type"),
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          finalUrl: redactedUrl(finalUrl, sensitiveNames),
        };
      }

      if (!response.ok) {
        const retryable = RETRYABLE_STATUSES.has(response.status);
        const delay = retryable && attempt < maxRetries
          ? retryDelayMilliseconds(
            response.headers.get("retry-after"),
            attempt,
            this.now(),
          )
          : null;
        try {
          await cancelResponseBody(response, abortController.signal);
        } catch {
          // The known HTTP status remains authoritative and sanitized.
        } finally {
          clearTimeout(timeout);
          responseAdmission?.release();
        }
        if (delay !== null) {
          await this.sleep(delay);
          continue;
        }
        throw new SourceFetchError({
          sourceId: source.id,
          status: response.status,
          retryable,
          failureKind: "transport",
          reason: retryable ? "retry limit exhausted" : "upstream rejected request",
        });
      }

      let body = "";
      let bodyFailure: SourceFetchError | null = null;
      try {
        body = await readBoundedBody(
          response,
          this.maxResponseBytes,
          source.id,
          abortController.signal,
        );
      } catch (error) {
        if (error instanceof SourceFetchError) {
          bodyFailure = error;
        } else {
          bodyFailure = responseBodyFailure(
            source.id,
            response.status,
            abortController.signal,
          );
        }
      } finally {
        clearTimeout(timeout);
        responseAdmission?.release();
      }
      if (bodyFailure !== null) {
        if (bodyFailure.retryable && attempt < maxRetries) {
          await this.sleep(retryDelayMilliseconds(null, attempt, this.now()));
          continue;
        }
        throw bodyFailure;
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
        finalUrl: redactedUrl(finalUrl, sensitiveNames),
      };
    }

    throw new SourceFetchError({
      sourceId: source.id,
      status: null,
      retryable: false,
      failureKind: "transport",
      reason: "unreachable retry state",
    });
  }
}
