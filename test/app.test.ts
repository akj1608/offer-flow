import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DownOfferCache } from "../src/cache/memory-cache.js";
import { createTestApp, readError } from "./helpers.js";

describe("HTTP surface", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = (await createTestApp()).app;
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports ok when the cache answers ping", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      service: "hotel-offer-orchestrator",
      redis: { ok: true, latencyMs: 0 },
      uptimeSeconds: expect.any(Number),
    });
    const body = res.json() as { uptimeSeconds: number };
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("lists Atlas, Nimbus, and the catalog cities", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providers: [
        { id: "atlas", name: "Atlas Beds", hotels: 12 },
        { id: "nimbus", name: "Nimbus Stays", hotels: 12 },
      ],
      cities: [
        { id: "delhi", name: "Delhi" },
        { id: "mumbai", name: "Mumbai" },
        { id: "bengaluru", name: "Bengaluru" },
        { id: "goa", name: "Goa" },
      ],
    });
  });

  it("serves the Offer Desk", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/html/);
    expect(res.body).toContain("Offer Desk");
  });

  it("returns JSON 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    const body = readError(res, 404, "NOT_FOUND");
    expect(body.error.message).toBe("No route for GET /v1/does-not-exist");
    expect(body.error.details).toBeNull();
  });
});

describe("health when Redis is refused", () => {
  it("stays HTTP 200 and reports degraded", async () => {
    const { app } = await createTestApp({ cache: new DownOfferCache() });
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "degraded",
        service: "hotel-offer-orchestrator",
        redis: {
          ok: false,
          latencyMs: 0,
          error: "connect ECONNREFUSED 127.0.0.1:6379",
          code: "ECONNREFUSED",
        },
      });
      const body = res.json() as { uptimeSeconds: number };
      expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });
});
