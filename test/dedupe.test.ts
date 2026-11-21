import { describe, expect, it } from "vitest";
import { dedupeOffers } from "../src/domain/dedupe.js";
import { adjustNightlyRate, priceStay } from "../src/domain/pricing.js";
import type { PricedOffer } from "../src/domain/types.js";

function priced(overrides: Partial<PricedOffer> & Pick<PricedOffer, "provider" | "name">): PricedOffer {
  const nightlyRate = overrides.nightlyRate ?? overrides.baseNightlyRate ?? 5000;
  const nights = overrides.nights ?? 2;
  return {
    providerHotelId: overrides.providerHotelId ?? `${overrides.provider}-1`,
    city: "Delhi",
    stars: 5,
    guestRating: 8,
    board: "breakfast",
    refundable: true,
    amenities: ["wifi"],
    commissionPct: 10,
    baseNightlyRate: nightlyRate,
    nightlyRate,
    totalPrice: nightlyRate * nights,
    nights,
    guests: 2,
    ...overrides,
  };
}

describe("dedupeOffers", () => {
  it("keeps the cheaper quote and records the savings against the other", () => {
    const { hotels, before } = dedupeOffers([
      priced({
        provider: "atlas",
        providerHotelId: "atl-dl-440",
        name: "Oberoi New Delhi",
        guestRating: 9.2,
        commissionPct: 40,
        nightlyRate: 9250,
        baseNightlyRate: 9250,
        totalPrice: 18500,
        amenities: ["pool", "spa", "airport-transfer"],
      }),
      priced({
        provider: "nimbus",
        providerHotelId: "nb-dl-8841",
        name: "The Oberoi",
        guestRating: 9.4,
        commissionPct: 12,
        nightlyRate: 8600,
        baseNightlyRate: 8600,
        totalPrice: 17200,
        amenities: ["pool", "spa", "club-lounge"],
      }),
    ]);

    expect(before).toBe(2);
    expect(hotels).toHaveLength(1);
    expect(hotels[0]).toMatchObject({
      hotelId: "delhi:the-oberoi",
      name: "The Oberoi",
      city: "Delhi",
      provider: "nimbus",
      providerName: "Nimbus Stays",
      providerHotelId: "nb-dl-8841",
      nightlyRate: 8600,
      totalPrice: 17200,
      currency: "INR",
      commissionPct: 12,
      guestRating: 9.4,
      savingsVsNext: 1300,
      amenities: ["pool", "spa", "club-lounge"],
    });
    expect(hotels[0]?.alternatives).toEqual([
      {
        provider: "atlas",
        providerName: "Atlas Beds",
        providerHotelId: "atl-dl-440",
        nightlyRate: 9250,
        totalPrice: 18500,
        guestRating: 9.2,
        commissionPct: 40,
      },
    ]);
  });

  it("breaks a price tie toward the higher guest rating", () => {
    const { hotels, before } = dedupeOffers([
      priced({
        provider: "atlas",
        providerHotelId: "atl-dl-777",
        name: "Khan Market Suites",
        guestRating: 8,
        commissionPct: 40,
        nightlyRate: 5100,
        baseNightlyRate: 5100,
        totalPrice: 10200,
      }),
      priced({
        provider: "nimbus",
        providerHotelId: "nb-dl-778",
        name: "Khan Market Suites",
        guestRating: 8.6,
        commissionPct: 15,
        nightlyRate: 5100,
        baseNightlyRate: 5100,
        totalPrice: 10200,
      }),
    ]);

    expect(before).toBe(2);
    expect(hotels).toHaveLength(1);
    expect(hotels[0]).toMatchObject({
      hotelId: "delhi:khan-market-suites",
      provider: "nimbus",
      guestRating: 8.6,
      commissionPct: 15,
      totalPrice: 10200,
      savingsVsNext: 0,
    });
    expect(hotels[0]?.alternatives[0]).toMatchObject({
      provider: "atlas",
      guestRating: 8,
      totalPrice: 10200,
      commissionPct: 40,
    });
  });

  it("breaks a price and rating tie toward atlas", () => {
    const { hotels, before } = dedupeOffers([
      priced({
        provider: "nimbus",
        providerHotelId: "nb-palm",
        name: "Palm Court",
        guestRating: 8.1,
        commissionPct: 25,
        nightlyRate: 4000,
        baseNightlyRate: 4000,
        totalPrice: 8000,
      }),
      priced({
        provider: "atlas",
        providerHotelId: "atl-palm",
        name: "Palm Court",
        guestRating: 8.1,
        commissionPct: 5,
        nightlyRate: 4000,
        baseNightlyRate: 4000,
        totalPrice: 8000,
      }),
    ]);

    expect(before).toBe(2);
    expect(hotels).toHaveLength(1);
    expect(hotels[0]).toMatchObject({
      hotelId: "delhi:palm-court",
      provider: "atlas",
      commissionPct: 5,
      guestRating: 8.1,
      totalPrice: 8000,
      savingsVsNext: 0,
    });
    expect(hotels[0]?.alternatives[0]).toMatchObject({
      provider: "nimbus",
      commissionPct: 25,
      totalPrice: 8000,
    });
  });

  it("leaves unrelated hotels as separate cards", () => {
    const { hotels, before } = dedupeOffers([
      priced({
        provider: "nimbus",
        providerHotelId: "nb-dl-8841",
        name: "The Oberoi",
        nightlyRate: 8600,
        baseNightlyRate: 8600,
        totalPrice: 17200,
      }),
      priced({
        provider: "atlas",
        providerHotelId: "atl-dl-102",
        name: "Taj Mahal Hotel",
        nightlyRate: 7100,
        baseNightlyRate: 7100,
        totalPrice: 14200,
      }),
    ]);

    expect(before).toBe(2);
    expect(hotels.map((hotel) => hotel.hotelId).sort()).toEqual([
      "delhi:taj-mahal-hotel",
      "delhi:the-oberoi",
    ]);
    expect(hotels.every((hotel) => hotel.alternatives.length === 0)).toBe(true);
    expect(hotels.every((hotel) => hotel.savingsVsNext === 0)).toBe(true);
  });
});

describe("adjustNightlyRate", () => {
  it("charges extra guests 15 percent on the nightly rate", () => {
    expect(adjustNightlyRate(8600, 2)).toBe(8600);
    expect(adjustNightlyRate(8600, 1)).toBe(8600);
    expect(adjustNightlyRate(8600, 4)).toBe(Math.round(8600 * 1.3));
    expect(priceStay(8600, 2, 2)).toEqual({ nightlyRate: 8600, totalPrice: 17200 });
    expect(priceStay(8600, 2, 4)).toEqual({
      nightlyRate: Math.round(8600 * 1.3),
      totalPrice: Math.round(8600 * 1.3) * 2,
    });
  });
});
