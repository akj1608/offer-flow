import { describe, expect, it } from "vitest";
import { AppError } from "../src/domain/errors.js";
import { cacheKey, resolveQuery, type Clock } from "../src/search/query.js";

const clock: Clock = { now: () => new Date("2026-11-21T00:00:00.000Z") };

describe("resolveQuery", () => {
  it("defaults to tomorrow and a two-night stay in UTC", () => {
    const query = resolveQuery({ city: "Delhi", guests: 2, sort: "price" }, clock);
    expect(query.cityId).toBe("delhi");
    expect(query.cityDisplay).toBe("Delhi");
    expect(query.checkIn).toBe("2026-11-22");
    expect(query.checkOut).toBe("2026-11-24");
    expect(query.nights).toBe(2);
    expect(cacheKey(query)).toBe("offers:v1:delhi:2026-11-22:2026-11-24:2:inr");
  });

  it("treats Bangalore as Bengaluru", () => {
    const query = resolveQuery(
      { city: "Bangalore", checkIn: "2026-11-22", checkOut: "2026-11-24", guests: 2, sort: "price" },
      clock,
    );
    expect(query.cityId).toBe("bengaluru");
    expect(cacheKey(query)).toBe("offers:v1:bengaluru:2026-11-22:2026-11-24:2:inr");
  });

  it("rejects a stay that ends before it starts", () => {
    expect(() =>
      resolveQuery(
        { city: "Delhi", checkIn: "2026-11-24", checkOut: "2026-11-22", guests: 2, sort: "price" },
        clock,
      ),
    ).toThrow(AppError);
  });

  it("rejects a minimum above the maximum", () => {
    expect(() =>
      resolveQuery(
        {
          city: "Delhi",
          checkIn: "2026-11-22",
          checkOut: "2026-11-24",
          guests: 2,
          sort: "price",
          minPrice: 5000,
          maxPrice: 1000,
        },
        clock,
      ),
    ).toThrow(/minPrice/);
  });
});
