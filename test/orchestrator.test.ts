import { describe, expect, it } from "vitest";
import { MemoryOfferCache } from "../src/cache/memory-cache.js";
import type { HotelProvider, ProviderQuery } from "../src/providers/hotel-provider.js";
import { MockHotelProvider } from "../src/providers/mock-provider.js";
import type { RawOffer } from "../src/domain/types.js";
import { OfferOrchestrator } from "../src/search/orchestrator.js";
import { resolveQuery } from "../src/search/query.js";
import { clock, logger } from "./helpers.js";

describe("OfferOrchestrator singleflight", () => {
  it("fans out once when two searches share an in-flight key", async () => {
    const counts = { atlas: 0, nimbus: 0 };
    const cache = new MemoryOfferCache();
    const providers: HotelProvider[] = (["atlas", "nimbus"] as const).map((id) => {
      const inner = new MockHotelProvider(id, 0);
      return {
        id,
        displayName: inner.displayName,
        async search(query: ProviderQuery, signal: AbortSignal): Promise<RawOffer[]> {
          counts[id] += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return inner.search(query, signal);
        },
      };
    });
    const orchestrator = new OfferOrchestrator(providers, cache, {
      ttlSeconds: 900,
      providerTimeoutMs: 500,
      logger,
    });
    const query = resolveQuery(
      {
        city: "Delhi",
        checkIn: "2026-11-22",
        checkOut: "2026-11-24",
        guests: 2,
        sort: "price",
      },
      clock,
    );

    const [left, right] = await Promise.all([
      orchestrator.search(query, { requestId: "req-left" }),
      orchestrator.search(query, { requestId: "req-right" }),
    ]);

    expect(counts).toEqual({ atlas: 1, nimbus: 1 });
    expect(left.meta.requestId).toBe("req-left");
    expect(right.meta.requestId).toBe("req-right");
    expect([left.meta.cache, right.meta.cache].sort()).toEqual(["COALESCED", "MISS"]);
    expect([left, right].find((result) => result.meta.cache === "MISS")?.meta.cacheReason).toBe("stored");
    expect([left, right].find((result) => result.meta.cache === "COALESCED")?.meta.cacheReason).toBe(
      "joined_inflight",
    );
    expect(left.meta.cacheKey).toBe("offers:v1:delhi:2026-11-22:2026-11-24:2:inr");
    expect(right.meta.cacheKey).toBe(left.meta.cacheKey);
    expect(left.offers).toEqual(right.offers);
    expect(left.offers.some((offer) => offer.hotelId === "delhi:the-oberoi")).toBe(true);
    await cache.quit();
  });
});
