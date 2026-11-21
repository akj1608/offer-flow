import type { ProviderId } from "./types.js";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class CacheUnavailableError extends Error {
  readonly code: string;
  readonly host: string | null;
  readonly port: number | null;

  constructor(
    message: string,
    options: { cause?: unknown; code?: string; host?: string | null; port?: number | null } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CacheUnavailableError";
    this.code = options.code ?? "REDIS_UNAVAILABLE";
    this.host = options.host ?? null;
    this.port = options.port ?? null;
  }
}

export class ProviderError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, message: string) {
    super(message);
    this.name = "ProviderError";
    this.providerId = providerId;
  }
}

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "REDIS_UNAVAILABLE";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "unexpected failure";
}
