import type { FastifyInstance } from "fastify";
import pino, { type Logger } from "pino";
import { expect } from "vitest";
import { DownOfferCache, MemoryOfferCache } from "../src/cache/memory-cache.js";
import type { OfferCache } from "../src/cache/offer-cache.js";
import { PROVIDERS, type HotelOffer, type ProviderId } from "../src/domain/types.js";
import { buildApp } from "../src/http/app.js";
import type { HotelProvider } from "../src/providers/hotel-provider.js";
import { MockHotelProvider } from "../src/providers/mock-provider.js";
import { OfferOrchestrator, type SearchResponse } from "../src/search/orchestrator.js";
import type { Clock } from "../src/search/query.js";

export const clock: Clock = {
  now: () => new Date("2026-11-21T00:00:00.000Z"),
};

export const logger: Logger = pino({ level: "silent" });

export const DELHI_QUERY: { [key: string]: string | number } = {
  city: "Delhi",
  checkIn: "2026-11-22",
  checkOut: "2026-11-24",
  guests: 2,
};

export const DELHI_KEY = "offers:v1:delhi:2026-11-22:2026-11-24:2:inr";

type Injected = Awaited<ReturnType<FastifyInstance["inject"]>>;

export type TestApp = {
  app: FastifyInstance;
  cache: OfferCache;
  orchestrator: OfferOrchestrator;
};

export async function createTestApp(options?: {
  cache?: OfferCache;
  providers?: readonly HotelProvider[];
  ttlSeconds?: number;
  providerTimeoutMs?: number;
}): Promise<TestApp> {
  const cache = options?.cache ?? new MemoryOfferCache();
  const providers = options?.providers ?? [
    new MockHotelProvider("atlas", 0),
    new MockHotelProvider("nimbus", 0),
  ];
  const orchestrator = new OfferOrchestrator(providers, cache, {
    ttlSeconds: options?.ttlSeconds ?? 900,
    providerTimeoutMs: options?.providerTimeoutMs ?? 500,
    logger,
  });
  const app = buildApp({ orchestrator, cache, logger, clock });
  await app.ready();
  return { app, cache, orchestrator };
}

export async function withApp<T>(
  run: (ctx: TestApp) => Promise<T>,
  options?: Parameters<typeof createTestApp>[0],
): Promise<T> {
  const ctx = await createTestApp(options);
  try {
    return await run(ctx);
  } finally {
    await ctx.app.close();
  }
}

export function offersUrl(query: { [key: string]: string | number | undefined }): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `/v1/offers?${qs}` : "/v1/offers";
}

export function getOffers(
  app: FastifyInstance,
  query: { [key: string]: string | number | undefined },
  headers?: Record<string, string>,
): Promise<Injected> {
  return app.inject({ method: "GET", url: offersUrl(query), headers });
}

function headerValue(res: Injected, name: string): string | undefined {
  const value = res.headers[name];
  if (Array.isArray(value)) return value.map(String).join(",");
  if (value == null) return undefined;
  return String(value);
}

export function readOffers(res: Injected): SearchResponse {
  expect(res.statusCode).toBe(200);
  expect(headerValue(res, "content-type")).toMatch(/json/);
  const body = res.json() as SearchResponse;
  expect(headerValue(res, "cache-control")).toBe("no-store");
  expect(headerValue(res, "x-cache")).toBe(body.meta.cache);
  expect(headerValue(res, "x-cache-reason")).toBe(body.meta.cacheReason);
  expect(headerValue(res, "x-cache-key")).toBe(body.meta.cacheKey);
  expect(headerValue(res, "x-offers-before-dedupe")).toBe(String(body.meta.offersBeforeDedupe));
  expect(headerValue(res, "x-offers-after-dedupe")).toBe(String(body.meta.offersAfterDedupe));
  expect(headerValue(res, "x-providers-ok")).toBe(body.meta.providersOk.join(",") || "-");
  expect(headerValue(res, "x-providers-failed")).toBe(
    body.meta.providersFailed.map((item) => item.provider).join(",") || "-",
  );
  expect(headerValue(res, "x-response-time-ms")).toBe(String(body.meta.tookMs));
  expect(headerValue(res, "x-request-id")).toBe(body.meta.requestId);
  expect(body.meta.requestId).toMatch(/^[\w.-]{1,80}$/);
  expect(body.meta.tookMs).toBeGreaterThanOrEqual(0);
  expect(body.meta.returned).toBe(body.offers.length);
  if (body.meta.cache === "HIT") {
    expect(headerValue(res, "x-cache-age")).toBe(String(body.meta.cacheAgeSeconds));
    expect(typeof body.meta.cacheAgeSeconds).toBe("number");
  } else {
    expect(headerValue(res, "x-cache-age")).toBeUndefined();
    expect(body.meta.cacheAgeSeconds).toBeNull();
  }
  if (body.meta.cache === "BYPASS") {
    expect(body.meta.cacheTtlSeconds).toBeNull();
  } else {
    expect(typeof body.meta.cacheTtlSeconds).toBe("number");
  }
  for (const offer of body.offers) expectOfferShape(offer);
  return body;
}

export function expectOfferShape(offer: HotelOffer): void {
  expect(offer.hotelId, offer.hotelId).toMatch(/^[a-z0-9-]+:[a-z0-9-]+$/);
  expect(offer.name.length).toBeGreaterThan(0);
  expect(offer.city.length).toBeGreaterThan(0);
  expect([3, 4, 5]).toContain(offer.stars);
  expect(offer.guestRating).toBeGreaterThan(0);
  expect(["room-only", "breakfast", "half-board"]).toContain(offer.board);
  expect(typeof offer.refundable).toBe("boolean");
  expect(offer.amenities.every((item) => typeof item === "string")).toBe(true);
  expect(offer.nights).toBeGreaterThan(0);
  expect(offer.guests).toBeGreaterThan(0);
  expect(offer.currency).toBe("INR");
  expect(offer.totalPrice).toBe(offer.nightlyRate * offer.nights);
  expect(offer.providerName).toBe(PROVIDERS[offer.provider]);
  expect(offer.providerHotelId.length).toBeGreaterThan(0);
  const next = offer.alternatives[0];
  if (next) {
    expect(offer.savingsVsNext).toBe(next.totalPrice - offer.totalPrice);
    expect(offer.totalPrice).toBeLessThanOrEqual(next.totalPrice);
  } else {
    expect(offer.savingsVsNext).toBe(0);
  }
  for (const alternative of offer.alternatives) {
    expect(alternative.providerName).toBe(PROVIDERS[alternative.provider as ProviderId]);
    expect(alternative.providerHotelId.length).toBeGreaterThan(0);
    expect(alternative.totalPrice).toBe(alternative.nightlyRate * offer.nights);
  }
}

export function findOffer(offers: HotelOffer[], hotelId: string): HotelOffer {
  const found = offers.find((offer) => offer.hotelId === hotelId);
  expect(found, hotelId).toBeDefined();
  return found as HotelOffer;
}

export function expectSorted(values: number[], direction: "asc" | "desc"): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1] ?? 0;
    const current = values[index] ?? 0;
    if (direction === "asc") expect(current).toBeGreaterThanOrEqual(previous);
    else expect(current).toBeLessThanOrEqual(previous);
  }
}

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    details: unknown;
    requestId: string;
  };
};

export function readError(res: Injected, status: number, code: string): ErrorBody {
  expect(res.statusCode).toBe(status);
  expect(headerValue(res, "content-type")).toMatch(/json/);
  const body = res.json() as ErrorBody;
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.requestId).toMatch(/^[\w.-]{1,80}$/);
  expect(body.error).toHaveProperty("details");
  expect(headerValue(res, "x-request-id")).toBe(body.error.requestId);
  return body;
}

export { DownOfferCache, MemoryOfferCache };
