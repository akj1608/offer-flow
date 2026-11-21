import { z } from "zod";
import type { HotelOffer, ProviderId } from "../domain/types.js";

const providerId = z.enum(["atlas", "nimbus"]);

const alternativeSchema = z.object({
  provider: providerId,
  providerName: z.string(),
  providerHotelId: z.string(),
  nightlyRate: z.number().int(),
  totalPrice: z.number().int(),
  guestRating: z.number(),
  commissionPct: z.number(),
});

const hotelOfferSchema = z.object({
  hotelId: z.string(),
  name: z.string(),
  city: z.string(),
  stars: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  guestRating: z.number(),
  board: z.enum(["room-only", "breakfast", "half-board"]),
  refundable: z.boolean(),
  amenities: z.array(z.string()),
  nights: z.number().int(),
  guests: z.number().int(),
  nightlyRate: z.number().int(),
  totalPrice: z.number().int(),
  currency: z.literal("INR"),
  provider: providerId,
  providerName: z.string(),
  providerHotelId: z.string(),
  commissionPct: z.number(),
  savingsVsNext: z.number().int(),
  alternatives: z.array(alternativeSchema),
});

export type CachedPayload = {
  version: 1;
  storedAt: string;
  ttlSeconds: number;
  offersBeforeDedupe: number;
  providersQueried: ProviderId[];
  providersOk: ProviderId[];
  providersFailed: { provider: ProviderId; message: string }[];
  offers: HotelOffer[];
};

const payloadSchema = z.object({
  version: z.literal(1),
  storedAt: z.string().min(10),
  ttlSeconds: z.number().int().positive(),
  offersBeforeDedupe: z.number().int().nonnegative(),
  providersQueried: z.array(providerId),
  providersOk: z.array(providerId),
  providersFailed: z.array(z.object({ provider: providerId, message: z.string() })),
  offers: z.array(hotelOfferSchema),
});

export function encodePayload(payload: CachedPayload): string {
  return JSON.stringify(payload);
}

export function decodePayload(raw: string): CachedPayload | null {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
