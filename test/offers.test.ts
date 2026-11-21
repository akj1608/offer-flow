import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { HotelProvider } from "../src/providers/hotel-provider.js";
import { MockHotelProvider } from "../src/providers/mock-provider.js";
import { cacheKey, resolveQuery } from "../src/search/query.js";
import {
  DELHI_KEY,
  DELHI_QUERY,
  DownOfferCache,
  clock,
  expectSorted,
  findOffer,
  getOffers,
  readError,
  readOffers,
  withApp,
} from "./helpers.js";

describe("GET /v1/offers", () => {
  it("defaults a Delhi search to tomorrow, two nights, two guests, and price order", async () => {
    await withApp(async ({ app }) => {
      const body = readOffers(await getOffers(app, { city: "Delhi" }));
      expect(body.query).toEqual({
        city: "Delhi",
        cityId: "delhi",
        checkIn: "2026-11-22",
        checkOut: "2026-11-24",
        nights: 2,
        guests: 2,
        currency: "INR",
        minPrice: null,
        maxPrice: null,
        sort: "price",
      });
      expect(body.meta.cache).toBe("MISS");
      expect(body.meta.cacheReason).toBe("stored");
      expect(body.meta.cacheKey).toBe(DELHI_KEY);
      expect(body.meta.providersQueried).toEqual(["atlas", "nimbus"]);
      expect(body.meta.providersOk).toEqual(["atlas", "nimbus"]);
      expect(body.meta.providersFailed).toEqual([]);
      expectSorted(body.offers.map((offer) => offer.totalPrice), "asc");
    });
  });

  it("stores a miss and replays the same stay as a fresh hit", async () => {
    await withApp(async ({ app }) => {
      const first = readOffers(await getOffers(app, DELHI_QUERY));
      expect(first.meta.cache).toBe("MISS");
      expect(first.meta.cacheReason).toBe("stored");
      expect(first.meta.cacheKey).toBe(DELHI_KEY);

      const second = readOffers(await getOffers(app, DELHI_QUERY));
      expect(second.meta.cache).toBe("HIT");
      expect(second.meta.cacheReason).toBe("fresh");
      expect(second.meta.cacheKey).toBe(DELHI_KEY);
      expect(second.offers).toEqual(first.offers);
      expect(second.meta.offersBeforeDedupe).toBe(first.meta.offersBeforeDedupe);
      expect(second.meta.offersAfterDedupe).toBe(first.meta.offersAfterDedupe);
    });
  });

  it("keeps one card per Delhi hotel and the cheaper alias", async () => {
    await withApp(async ({ app }) => {
      const body = readOffers(await getOffers(app, DELHI_QUERY));
      expect(body.meta.offersBeforeDedupe).toBe(10);
      expect(body.meta.offersAfterDedupe).toBe(6);
      expect(body.meta.offersAfterDedupe).toBeLessThan(body.meta.offersBeforeDedupe);
      expect(body.meta.returned).toBe(body.meta.offersAfterDedupe);
      expect(body.offers.map((offer) => offer.hotelId)).toEqual([
        "delhi:haveli-court",
        "delhi:sunder-nagar-house",
        "delhi:lodhi-house",
        "delhi:khan-market-suites",
        "delhi:taj-mahal-hotel",
        "delhi:the-oberoi",
      ]);
      expect(body.offers.filter((offer) => offer.hotelId === "delhi:the-oberoi")).toHaveLength(1);

      expect(findOffer(body.offers, "delhi:the-oberoi")).toMatchObject({
        name: "The Oberoi",
        city: "Delhi",
        stars: 5,
        guestRating: 9.4,
        board: "breakfast",
        refundable: true,
        amenities: ["pool", "spa", "club-lounge"],
        nights: 2,
        guests: 2,
        nightlyRate: 8600,
        totalPrice: 17200,
        currency: "INR",
        provider: "nimbus",
        providerName: "Nimbus Stays",
        providerHotelId: "nb-dl-8841",
        commissionPct: 12,
        savingsVsNext: 1300,
        alternatives: [
          {
            provider: "atlas",
            providerName: "Atlas Beds",
            providerHotelId: "atl-dl-440",
            nightlyRate: 9250,
            totalPrice: 18500,
            guestRating: 9.2,
            commissionPct: 10,
          },
        ],
      });

      expect(findOffer(body.offers, "delhi:taj-mahal-hotel")).toMatchObject({
        name: "Taj Mahal Hotel",
        provider: "atlas",
        providerName: "Atlas Beds",
        nightlyRate: 7100,
        totalPrice: 14200,
        guestRating: 9,
        commissionPct: 11,
        savingsVsNext: 750,
        alternatives: [
          {
            provider: "nimbus",
            providerName: "Nimbus Stays",
            providerHotelId: "nb-dl-220",
            nightlyRate: 7475,
            totalPrice: 14950,
            guestRating: 8.8,
            commissionPct: 9,
          },
        ],
      });

      expect(findOffer(body.offers, "delhi:khan-market-suites")).toMatchObject({
        name: "Khan Market Suites",
        provider: "nimbus",
        nightlyRate: 5100,
        totalPrice: 10200,
        guestRating: 8.6,
        commissionPct: 15,
        savingsVsNext: 0,
        alternatives: [
          {
            provider: "atlas",
            nightlyRate: 5100,
            totalPrice: 10200,
            guestRating: 8,
            commissionPct: 10,
          },
        ],
      });

      const sunder = findOffer(body.offers, "delhi:sunder-nagar-house");
      expect(sunder).toMatchObject({
        name: "Sunder Nagar House",
        provider: "atlas",
        nightlyRate: 4000,
        totalPrice: 8000,
        commissionPct: 5,
        guestRating: 8.2,
        savingsVsNext: 1000,
      });
      expect(sunder.commissionPct).toBeLessThan(sunder.alternatives[0]?.commissionPct ?? 0);
      expect(sunder.guestRating).toBeLessThan(sunder.alternatives[0]?.guestRating ?? 0);
      expect(sunder.alternatives[0]).toMatchObject({
        provider: "nimbus",
        nightlyRate: 4500,
        totalPrice: 9000,
        commissionPct: 25,
        guestRating: 8.3,
      });
    });
  });

  it("prices Bangalore as Bengaluru and keeps the cheaper ITC Windsor", async () => {
    await withApp(async ({ app }) => {
      const body = readOffers(
        await getOffers(app, {
          city: "Bangalore",
          checkIn: "2026-11-22",
          checkOut: "2026-11-24",
          guests: 2,
        }),
      );
      expect(body.query.city).toBe("Bengaluru");
      expect(body.query.cityId).toBe("bengaluru");
      expect(body.meta.cacheKey).toBe("offers:v1:bengaluru:2026-11-22:2026-11-24:2:inr");
      expect(body.offers.filter((offer) => offer.hotelId === "bengaluru:itc-windsor")).toHaveLength(1);
      expect(findOffer(body.offers, "bengaluru:itc-windsor")).toMatchObject({
        name: "ITC Windsor Bengaluru",
        city: "Bengaluru",
        provider: "nimbus",
        providerName: "Nimbus Stays",
        nightlyRate: 6450,
        totalPrice: 12900,
        guestRating: 9,
        commissionPct: 12,
        savingsVsNext: 500,
        alternatives: [
          {
            provider: "atlas",
            providerName: "Atlas Beds",
            providerHotelId: "atl-blr-2",
            nightlyRate: 6700,
            totalPrice: 13400,
            guestRating: 9.1,
            commissionPct: 10,
          },
        ],
      });
    });
  });

  it("caches an empty Jaipur result", async () => {
    await withApp(async ({ app }) => {
      const first = readOffers(
        await getOffers(app, {
          city: "Jaipur",
          checkIn: "2026-11-22",
          checkOut: "2026-11-24",
          guests: 2,
        }),
      );
      expect(first.query).toMatchObject({ city: "Jaipur", cityId: "jaipur", nights: 2, guests: 2 });
      expect(first.meta.cache).toBe("MISS");
      expect(first.meta.cacheReason).toBe("stored");
      expect(first.meta.cacheKey).toBe("offers:v1:jaipur:2026-11-22:2026-11-24:2:inr");
      expect(first.offers).toEqual([]);
      expect(first.meta.returned).toBe(0);
      expect(first.meta.offersBeforeDedupe).toBe(0);
      expect(first.meta.offersAfterDedupe).toBe(0);
      expect(first.meta.providersOk).toEqual(["atlas", "nimbus"]);

      const second = readOffers(
        await getOffers(app, {
          city: "Jaipur",
          checkIn: "2026-11-22",
          checkOut: "2026-11-24",
          guests: 2,
        }),
      );
      expect(second.meta.cache).toBe("HIT");
      expect(second.meta.cacheReason).toBe("fresh");
      expect(second.offers).toEqual([]);
    });
  });

  it("reuses one cache entry for minPrice, maxPrice, and sort", async () => {
    await withApp(async ({ app }) => {
      const filtered = readOffers(await getOffers(app, { ...DELHI_QUERY, minPrice: 15000 }));
      expect(filtered.meta.cache).toBe("MISS");
      expect(filtered.meta.cacheReason).toBe("stored");
      expect(filtered.meta.cacheKey).toBe(DELHI_KEY);
      expect(filtered.query.minPrice).toBe(15000);
      expect(filtered.query.maxPrice).toBeNull();
      expect(filtered.offers.map((offer) => offer.hotelId)).toEqual(["delhi:the-oberoi"]);
      expect(filtered.meta.returned).toBeLessThan(filtered.meta.offersAfterDedupe);

      const open = readOffers(await getOffers(app, DELHI_QUERY));
      expect(open.meta.cache).toBe("HIT");
      expect(open.meta.cacheReason).toBe("fresh");
      expect(open.meta.cacheKey).toBe(filtered.meta.cacheKey);
      expect(open.meta.returned).toBeGreaterThan(filtered.meta.returned);
      expect(open.meta.returned).toBe(open.meta.offersAfterDedupe);
      expect(open.meta.offersAfterDedupe).toBe(filtered.meta.offersAfterDedupe);
      expect(open.offers.map((offer) => offer.hotelId)).toContain("delhi:sunder-nagar-house");
      expect(open.offers.map((offer) => offer.hotelId)).toContain("delhi:the-oberoi");

      const byRating = readOffers(await getOffers(app, { ...DELHI_QUERY, sort: "rating" }));
      expect(byRating.meta.cache).toBe("HIT");
      expect(byRating.meta.cacheKey).toBe(DELHI_KEY);
      expect(byRating.query.sort).toBe("rating");
      expect(byRating.offers.map((offer) => offer.hotelId).sort()).toEqual(
        open.offers.map((offer) => offer.hotelId).sort(),
      );
      expectSorted(byRating.offers.map((offer) => offer.guestRating), "desc");

      const byStars = readOffers(await getOffers(app, { ...DELHI_QUERY, sort: "stars" }));
      expect(byStars.meta.cache).toBe("HIT");
      expect(byStars.meta.cacheKey).toBe(DELHI_KEY);
      expectSorted(byStars.offers.map((offer) => offer.stars), "desc");

      const capped = readOffers(await getOffers(app, { ...DELHI_QUERY, maxPrice: 8000 }));
      expect(capped.meta.cache).toBe("HIT");
      expect(capped.meta.cacheKey).toBe(DELHI_KEY);
      expect(capped.query.maxPrice).toBe(8000);
      expect(capped.meta.offersAfterDedupe).toBe(open.meta.offersAfterDedupe);
      expect(capped.offers.map((offer) => offer.hotelId)).toContain("delhi:sunder-nagar-house");
      expect(capped.offers.map((offer) => offer.hotelId)).not.toContain("delhi:the-oberoi");
      expect(capped.meta.returned).toBeLessThan(open.meta.returned);
      expect(capped.offers.every((offer) => offer.totalPrice <= 8000)).toBe(true);
    });
  });

  it("prices four guests on a separate cache key", async () => {
    await withApp(async ({ app }) => {
      const couple = readOffers(await getOffers(app, DELHI_QUERY));
      const party = readOffers(await getOffers(app, { ...DELHI_QUERY, guests: 4 }));
      expect(couple.meta.cache).toBe("MISS");
      expect(party.meta.cache).toBe("MISS");
      expect(party.meta.cacheKey).toBe("offers:v1:delhi:2026-11-22:2026-11-24:4:inr");
      expect(party.meta.cacheKey).not.toBe(couple.meta.cacheKey);

      const nightly = Math.round(8600 * 1.3);
      const atlasNightly = Math.round(9250 * 1.3);
      const oberoi = findOffer(party.offers, "delhi:the-oberoi");
      expect(oberoi).toMatchObject({
        provider: "nimbus",
        guests: 4,
        nights: 2,
        nightlyRate: nightly,
        totalPrice: nightly * 2,
        savingsVsNext: atlasNightly * 2 - nightly * 2,
      });
      expect(oberoi.alternatives[0]).toMatchObject({
        provider: "atlas",
        nightlyRate: atlasNightly,
        totalPrice: atlasNightly * 2,
      });

      const again = readOffers(await getOffers(app, DELHI_QUERY));
      expect(again.meta.cache).toBe("HIT");
      expect(again.meta.cacheKey).toBe(couple.meta.cacheKey);
    });
  });

  it("accepts eight guests and prices the extra occupancy", async () => {
    await withApp(async ({ app }) => {
      const body = readOffers(await getOffers(app, { ...DELHI_QUERY, guests: 8 }));
      expect(body.query.guests).toBe(8);
      const nightly = Math.round(8600 * (1 + 6 * 0.15));
      expect(findOffer(body.offers, "delhi:the-oberoi").nightlyRate).toBe(nightly);
    });
  });

  it("bypasses the cache when Redis is unreachable and still keeps Nimbus on the Oberoi", async () => {
    await withApp(async ({ app }) => {
      const first = readOffers(await getOffers(app, DELHI_QUERY));
      const second = readOffers(await getOffers(app, DELHI_QUERY));
      for (const body of [first, second]) {
        expect(body.meta.cache).toBe("BYPASS");
        expect(body.meta.cacheReason).toBe("redis_unreachable");
        expect(body.meta.cacheKey).toBe(DELHI_KEY);
        expect(findOffer(body.offers, "delhi:the-oberoi").provider).toBe("nimbus");
      }
      expect(second.offers).toEqual(first.offers);
    }, { cache: new DownOfferCache() });
  });

  it("serves a full miss after a fault-injected Atlas failure", async () => {
    await withApp(async ({ app }) => {
      const partial = readOffers(await getOffers(app, { ...DELHI_QUERY, failProvider: "atlas" }));
      expect(partial.meta.cache).toBe("BYPASS");
      expect(partial.meta.cacheReason).toBe("fault_injection");
      expect(partial.meta.cacheKey).toBe(DELHI_KEY);
      expect(partial.meta.providersQueried).toEqual(["atlas", "nimbus"]);
      expect(partial.meta.providersOk).toEqual(["nimbus"]);
      expect(partial.meta.providersFailed).toEqual([{ provider: "atlas", message: "injected failure" }]);
      expect(findOffer(partial.offers, "delhi:the-oberoi")).toMatchObject({
        provider: "nimbus",
        nightlyRate: 8600,
        totalPrice: 17200,
        alternatives: [],
      });
      expect(partial.offers.every((offer) => offer.provider === "nimbus")).toBe(true);

      const full = readOffers(await getOffers(app, DELHI_QUERY));
      expect(full.meta.cache).toBe("MISS");
      expect(full.meta.cacheReason).toBe("stored");
      expect(full.meta.providersOk).toEqual(["atlas", "nimbus"]);
      expect(full.meta.providersFailed).toEqual([]);
      expect(findOffer(full.offers, "delhi:the-oberoi").alternatives[0]?.provider).toBe("atlas");
    });
  });

  it("replaces a corrupt cache entry and then hits", async () => {
    await withApp(async ({ app, cache }) => {
      const key = cacheKey(
        resolveQuery(
          {
            city: "Delhi",
            checkIn: "2026-11-22",
            checkOut: "2026-11-24",
            guests: 2,
            sort: "price",
          },
          clock,
        ),
      );
      expect(key).toBe(DELHI_KEY);
      await cache.set(key, "not-json", 900);

      const refreshed = readOffers(await getOffers(app, DELHI_QUERY));
      expect(refreshed.meta.cache).toBe("MISS");
      expect(refreshed.meta.cacheReason).toBe("refreshed_corrupt");
      expect(refreshed.meta.cacheKey).toBe(key);
      expect(findOffer(refreshed.offers, "delhi:the-oberoi").provider).toBe("nimbus");

      const hit = readOffers(await getOffers(app, DELHI_QUERY));
      expect(hit.meta.cache).toBe("HIT");
      expect(hit.meta.cacheReason).toBe("fresh");
      expect(hit.offers).toEqual(refreshed.offers);
    });
  });

  it("echoes a valid X-Request-Id", async () => {
    await withApp(async ({ app }) => {
      const res = await getOffers(app, DELHI_QUERY, { "x-request-id": "req-123" });
      const body = readOffers(res);
      expect(res.headers["x-request-id"]).toBe("req-123");
      expect(body.meta.requestId).toBe("req-123");
    });
  });

  it("returns 502 when both providers fail and does not cache that failure", async () => {
    const failing = (id: "atlas" | "nimbus"): HotelProvider => ({
      id,
      displayName: id === "atlas" ? "Atlas Beds" : "Nimbus Stays",
      async search() {
        throw new Error(`${id} exploded`);
      },
    });
    await withApp(async ({ app }) => {
      const first = await getOffers(app, DELHI_QUERY);
      const second = await getOffers(app, DELHI_QUERY);
      for (const res of [first, second]) {
        const body = readError(res, 502, "PROVIDERS_UNAVAILABLE");
        expect(body.error.message).toBe("Every hotel provider failed");
        expect(body.error.details).toEqual({
          providersFailed: [
            { provider: "atlas", message: "atlas exploded" },
            { provider: "nimbus", message: "nimbus exploded" },
          ],
        });
        expect(res.headers["x-cache"]).not.toBe("HIT");
      }
    }, { providers: [failing("atlas"), failing("nimbus")] });
  });

  it("returns Nimbus offers when Atlas exceeds the provider timeout", async () => {
    const slowAtlas: HotelProvider = {
      id: "atlas",
      displayName: "Atlas Beds",
      async search() {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          timer.unref();
        });
        return [];
      },
    };
    await withApp(async ({ app }) => {
      const started = Date.now();
      const body = readOffers(await getOffers(app, DELHI_QUERY));
      expect(Date.now() - started).toBeLessThan(180);
      expect(body.meta.providersFailed).toEqual([{ provider: "atlas", message: "timed out" }]);
      expect(body.meta.providersOk).toEqual(["nimbus"]);
      expect(body.offers.length).toBeGreaterThan(0);
      expect(body.offers.every((offer) => offer.provider === "nimbus")).toBe(true);
      expect(body.offers.every((offer) => offer.alternatives.length === 0)).toBe(true);
      expect(findOffer(body.offers, "delhi:the-oberoi")).toMatchObject({
        provider: "nimbus",
        nightlyRate: 8600,
        totalPrice: 17200,
      });
    }, {
      providers: [slowAtlas, new MockHotelProvider("nimbus", 0)],
      providerTimeoutMs: 30,
    });
  });
});

describe("invalid /v1/offers queries", () => {
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await import("./helpers.js").then((helpers) => helpers.createTestApp());
    app = ctx.app;
    close = () => ctx.app.close();
  });

  afterAll(async () => {
    await close();
  });

  it.each([
    {
      name: "missing city",
      url: "/v1/offers",
      message: "Search query is invalid",
      path: "city",
    },
    {
      name: "checkout before check-in",
      url: "/v1/offers?city=Delhi&checkIn=2026-11-24&checkOut=2026-11-22",
      message: "checkOut must be after checkIn",
      path: undefined,
    },
    {
      name: "minPrice above maxPrice",
      url: "/v1/offers?city=Delhi&minPrice=8000&maxPrice=1000",
      message: "minPrice cannot be greater than maxPrice",
      path: undefined,
    },
    {
      name: "zero guests",
      url: "/v1/offers?city=Delhi&guests=0",
      message: "Search query is invalid",
      path: "guests",
    },
    {
      name: "unknown city",
      url: "/v1/offers?city=x",
      message: "Search query is invalid",
      path: "city",
    },
    {
      name: "nine guests",
      url: "/v1/offers?city=Delhi&guests=9",
      message: "Search query is invalid",
      path: "guests",
    },
  ])("$name returns 400 INVALID_QUERY", async ({ url, message, path }) => {
    const res = await app.inject({ method: "GET", url });
    const body = readError(res, 400, "INVALID_QUERY");
    expect(body.error.message).toBe(message);
    if (path) {
      expect(body.error.details).toEqual({
        issues: expect.arrayContaining([expect.objectContaining({ path })]),
      });
    } else {
      expect(body.error.details).toBeNull();
    }
  });
});
