import type { Context } from "hono";

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: 401 | 403 | 404 | 422 | 500,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthenticationRequiredError extends ApiError {
  constructor() {
    super("AUTH_REQUIRED", 401, "Authentication is required.");
    this.name = "AuthenticationRequiredError";
  }
}

export class ForbiddenError extends ApiError {
  constructor() {
    super("AUTH_FORBIDDEN", 403, "You are not authorized to access this resource.");
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ApiError {
  constructor() {
    super("NOT_FOUND", 404, "The requested resource was not found.");
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ApiError {
  constructor() {
    super("VALIDATION_FAILED", 422, "The request could not be validated.");
    this.name = "ValidationError";
  }
}

export class InternalError extends ApiError {
  constructor() {
    super("INTERNAL_ERROR", 500, "An internal error occurred.");
    this.name = "InternalError";
  }
}

export function errorBody(error: ApiError) {
  return { error: { code: error.code, message: error.message } };
}

export function jsonError(context: Context, error: ApiError): Response {
  return context.json(errorBody(error), error.status);
}

export function internalErrorResponse(): Response {
  const error = new InternalError();
  return new Response(JSON.stringify(errorBody(error)), {
    status: error.status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}
