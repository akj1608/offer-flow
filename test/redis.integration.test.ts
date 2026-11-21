import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisOfferCache } from "../src/cache/redis-cache.js";
import { cacheKey, resolveQuery } from "../src/search/query.js";
import { clock, createTestApp, getOffers, logger, readOffers } from "./helpers.js";

const QUERY = {
  city: "Delhi",
  checkIn: "2026-12-10",
  checkOut: "2026-12-12",
  guests: 2,
};
const KEY = "offers:v1:delhi:2026-12-10:2026-12-12:2:inr";

describe("RedisOfferCache", () => {
  const cache = new RedisOfferCache("redis://127.0.0.1:6379", logger);
  let redisUp = false;

  beforeAll(async () => {
    try {
      const ping = await cache.ping();
      redisUp = ping.ok === true;
    } catch {
      redisUp = false;
    }
    if (!redisUp) await cache.quit().catch(() => undefined);
  });

  afterAll(async () => {
    if (redisUp) await cache.quit().catch(() => undefined);
  });

  it("writes a Delhi stay on a miss and reads it back on a hit", async (ctx) => {
    if (!redisUp) ctx.skip();

    expect(cacheKey(resolveQuery({ ...QUERY, sort: "price" }, clock))).toBe(KEY);
    await cache.delete(KEY);
    const { app } = await createTestApp({ cache });
    try {
      const first = readOffers(await getOffers(app, QUERY));
      expect(first.meta.cache).toBe("MISS");
      expect(first.meta.cacheReason).toBe("stored");
      expect(first.meta.cacheKey).toBe(KEY);

      const second = readOffers(await getOffers(app, QUERY));
      expect(second.meta.cache).toBe("HIT");
      expect(second.meta.cacheReason).toBe("fresh");
      expect(second.offers).toEqual(first.offers);

      const stored = await cache.get(KEY);
      expect(typeof stored).toBe("string");
      expect(stored).toContain("delhi:the-oberoi");
    } finally {
      await app.close();
    }
  });
});
