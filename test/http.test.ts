import type { InjectOptions } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DownOfferCache, MemoryOfferCache } from "../src/cache/memory-cache.js";
import type { ProviderId } from "../src/domain/types.js";
import { buildApp } from "../src/http/app.js";
import type { HotelProvider } from "../src/providers/hotel-provider.js";
import { MockHotelProvider } from "../src/providers/mock-provider.js";
import { OfferOrchestrator } from "../src/search/orchestrator.js";
import { cacheKey, resolveQuery, type Clock } from "../src/search/query.js";

const clock: Clock = { now: () => new Date("2026-11-21T00:00:00.000Z") };
const logger = pino({ level: "silent" });
const DELHI = "/v1/offers?city=delhi&checkIn=2026-11-22&checkOut=2026-11-24&guests=2";

const apps: FastifyInstance[] = [];

function header(response: { headers: Record<string, unknown> }, name: string): string {
  const value = response.headers[name];
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value == null ? "" : String(value);
}

function build(options?: {
  cache?: MemoryOfferCache | DownOfferCache;
  providers?: HotelProvider[];
  timeoutMs?: number;
}) {
  const cache = options?.cache ?? new MemoryOfferCache();
  const providers = options?.providers ?? [new MockHotelProvider("atlas", 0), new MockHotelProvider("nimbus", 0)];
  const orchestrator = new OfferOrchestrator(providers, cache, {
    ttlSeconds: 900,
    providerTimeoutMs: options?.timeoutMs ?? 500,
    logger,
  });
  const app = buildApp({ orchestrator, cache, logger, clock });
  apps.push(app);
  return { app, cache };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function offer(body: { offers: Array<{ hotelId: string }> }, hotelId: string) {
  return body.offers.find((item) => item.hotelId === hotelId);
}

describe("GET /v1/offers", () => {
  it("returns the cheaper quote when both providers list the same hotel", async () => {
    const { app } = build();
    const response = await app.inject({ method: "GET", url: DELHI });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(header(response, "x-cache")).toBe("MISS");
    expect(header(response, "x-cache-reason")).toBe("stored");
    expect(header(response, "cache-control")).toBe("no-store");
    expect(body.meta.cache).toBe("MISS");
    expect(body.meta.offersBeforeDedupe).toBe(10);
    expect(body.meta.offersAfterDedupe).toBe(6);
    expect(body.meta.offersAfterDedupe).toBeLessThan(body.meta.offersBeforeDedupe);

    const oberoi = offer(body, "delhi:the-oberoi");
    expect(oberoi).toMatchObject({
      provider: "nimbus",
      totalPrice: 17_200,
      savingsVsNext: 1_300,
    });
    expect(oberoi.alternatives[0]).toMatchObject({ provider: "atlas", totalPrice: 18_500 });

    const taj = offer(body, "delhi:taj-mahal-hotel");
    expect(taj.provider).toBe("atlas");

    const khan = offer(body, "delhi:khan-market-suites");
    expect(khan.provider).toBe("nimbus");
    expect(khan.totalPrice).toBe(khan.alternatives[0].totalPrice);
    expect(khan.guestRating).toBeGreaterThan(khan.alternatives[0].guestRating);

    const sunder = offer(body, "delhi:sunder-nagar-house");
    expect(sunder.provider).toBe("atlas");
    expect(sunder.commissionPct).toBe(5);
    expect(sunder.alternatives[0].commissionPct).toBe(25);
    expect(sunder.totalPrice).toBeLessThan(sunder.alternatives[0].totalPrice);
    expect(body.offers.filter((item: { hotelId: string }) => item.hotelId === "delhi:the-oberoi")).toHaveLength(1);
  });

  it("reads the second identical search from the cache", async () => {
    const { app } = build();
    const first = await app.inject({ method: "GET", url: DELHI });
    const second = await app.inject({ method: "GET", url: DELHI });
    expect(header(first, "x-cache")).toBe("MISS");
    expect(header(second, "x-cache")).toBe("HIT");
    expect(header(second, "x-cache-reason")).toBe("fresh");
    expect(header(second, "x-cache-age")).toBe("0");
    expect(second.json().offers).toEqual(first.json().offers);
    expect(second.json().meta.cache).toBe(header(second, "x-cache"));
  });

  it("applies a later price filter to the cached merged list", async () => {
    const { app } = build();
    const narrow = await app.inject({ method: "GET", url: `${DELHI}&minPrice=15000` });
    const wide = await app.inject({ method: "GET", url: DELHI });
    expect(header(narrow, "x-cache")).toBe("MISS");
    expect(narrow.json().meta.returned).toBe(1);
    expect(header(wide, "x-cache")).toBe("HIT");
    expect(wide.json().meta.returned).toBe(6);
  });

  it("keeps a different guest count on a different key and reprices the night", async () => {
    const { app } = build();
    const two = await app.inject({ method: "GET", url: DELHI });
    const four = await app.inject({ method: "GET", url: DELHI.replace("guests=2", "guests=4") });
    expect(header(two, "x-cache")).toBe("MISS");
    expect(header(four, "x-cache")).toBe("MISS");
    const oberoi = offer(four.json(), "delhi:the-oberoi");
    expect(oberoi.nightlyRate).toBe(Math.round(8600 * 1.3));
    expect(oberoi.guests).toBe(4);
  });

  it("still returns the cheaper offer when Redis is unreachable", async () => {
    const { app } = build({ cache: new DownOfferCache() });
    const first = await app.inject({ method: "GET", url: DELHI });
    const second = await app.inject({ method: "GET", url: DELHI });
    expect(header(first, "x-cache")).toBe("BYPASS");
    expect(header(first, "x-cache-reason")).toBe("redis_unreachable");
    expect(header(second, "x-cache")).toBe("BYPASS");
    expect(offer(first.json(), "delhi:the-oberoi").provider).toBe("nimbus");
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "degraded",
      service: "hotel-offer-orchestrator",
      redis: { ok: false, code: "ECONNREFUSED" },
    });
  });

  it("does not poison the cache when a provider is forced to fail", async () => {
    const { app } = build();
    const failed = await app.inject({ method: "GET", url: `${DELHI}&failProvider=atlas` });
    expect(failed.statusCode).toBe(200);
    expect(header(failed, "x-cache")).toBe("BYPASS");
    expect(header(failed, "x-cache-reason")).toBe("fault_injection");
    expect(failed.json().meta.providersOk).toEqual(["nimbus"]);
    expect(failed.json().meta.providersFailed.map((item: { provider: string }) => item.provider)).toContain("atlas");
    expect(offer(failed.json(), "delhi:the-oberoi").provider).toBe("nimbus");
    const next = await app.inject({ method: "GET", url: DELHI });
    expect(header(next, "x-cache")).toBe("MISS");
    expect(next.json().meta.providersOk).toEqual(["atlas", "nimbus"]);
  });

  it("overwrites a corrupt payload and then hits", async () => {
    const cache = new MemoryOfferCache();
    const { app } = build({ cache });
    const query = resolveQuery(
      { city: "delhi", checkIn: "2026-11-22", checkOut: "2026-11-24", guests: 2, sort: "price" },
      clock,
    );
    await cache.set(cacheKey(query), "not-json", 900);
    const first = await app.inject({ method: "GET", url: DELHI });
    const second = await app.inject({ method: "GET", url: DELHI });
    expect(header(first, "x-cache")).toBe("MISS");
    expect(header(first, "x-cache-reason")).toBe("refreshed_corrupt");
    expect(header(second, "x-cache")).toBe("HIT");
  });

  it("caches an empty city instead of pretending the search failed", async () => {
    const { app } = build();
    const url = "/v1/offers?city=Jaipur&checkIn=2026-11-22&checkOut=2026-11-24&guests=2";
    const first = await app.inject({ method: "GET", url });
    const second = await app.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    expect(first.json().offers).toEqual([]);
    expect(header(first, "x-cache")).toBe("MISS");
    expect(header(second, "x-cache")).toBe("HIT");
  });

  it("finds Bengaluru inventory when the city is spelled Bangalore", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "GET",
      url: "/v1/offers?city=Bangalore&checkIn=2026-11-22&checkOut=2026-11-24&guests=2",
    });
    const windsor = offer(response.json(), "bengaluru:itc-windsor");
    expect(windsor.provider).toBe("nimbus");
    expect(windsor.totalPrice).toBe(6450 * 2);
    expect(response.json().query.cityId).toBe("bengaluru");
  });

  it("rejects a bad query", async () => {
    const { app } = build();
    const cases: InjectOptions[] = [
      { method: "GET", url: "/v1/offers" },
      { method: "GET", url: "/v1/offers?city=x" },
      { method: "GET", url: "/v1/offers?city=delhi&guests=0" },
      { method: "GET", url: "/v1/offers?city=delhi&checkIn=2026-11-24&checkOut=2026-11-22" },
      { method: "GET", url: `${DELHI}&minPrice=9000&maxPrice=1000` },
    ];
    for (const options of cases) {
      const response = await app.inject(options);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_QUERY");
    }
  });

  it("echoes a caller request id", async () => {
    const { app } = build();
    const response = await app.inject({ method: "GET", url: DELHI, headers: { "x-request-id": "req-123" } });
    expect(header(response, "x-request-id")).toBe("req-123");
    expect(response.json().meta.requestId).toBe("req-123");
  });

  it("does not cache a total provider failure", async () => {
    const boom = (id: ProviderId): HotelProvider => ({
      id,
      displayName: id,
      async search() {
        throw new Error("down");
      },
    });
    const { app } = build({ providers: [boom("atlas"), boom("nimbus")] });
    const first = await app.inject({ method: "GET", url: DELHI });
    const second = await app.inject({ method: "GET", url: DELHI });
    expect(first.statusCode).toBe(502);
    expect(first.json().error.code).toBe("PROVIDERS_UNAVAILABLE");
    expect(second.statusCode).toBe(502);
    expect(header(second, "x-cache")).not.toBe("HIT");
  });

  it("returns the healthy provider when the other exceeds the timeout", async () => {
    const slow: HotelProvider = {
      id: "atlas",
      displayName: "Atlas Beds",
      async search() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return [];
      },
    };
    const { app } = build({
      providers: [slow, new MockHotelProvider("nimbus", 0)],
      timeoutMs: 30,
    });
    const response = await app.inject({ method: "GET", url: DELHI });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.providersFailed.map((item: { provider: string }) => item.provider)).toContain("atlas");
    expect(response.json().meta.providersOk).toEqual(["nimbus"]);
    expect(offer(response.json(), "delhi:the-oberoi").provider).toBe("nimbus");
  });
});

describe("desk and health", () => {
  it("serves the desk and reports a healthy cache", async () => {
    const { app } = build();
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Offer Desk");
    expect(header(page, "content-security-policy")).toContain("default-src 'self'");
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
    const providers = await app.inject({ method: "GET", url: "/v1/providers" });
    expect(providers.json().cities.map((city: { id: string }) => city.id)).toContain("delhi");
    const missing = await app.inject({ method: "GET", url: "/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });
});
