import { z } from "zod";
import { AppError } from "../domain/errors.js";
import { canonicalCity, displayCity } from "../domain/identity.js";
import type { ProviderId, Sort } from "../domain/types.js";

const DAY_MS = 86_400_000;

export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

const optionalDate = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
);

const optionalMoney = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : value),
  z.coerce.number().int().nonnegative().optional(),
);

export const SearchQuerySchema = z.object({
  city: z
    .string()
    .trim()
    .min(2, "city must be at least 2 characters")
    .max(40)
    .regex(/^[a-zA-Z][a-zA-Z .'-]*$/, "city must be letters"),
  checkIn: optionalDate,
  checkOut: optionalDate,
  guests: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(8).default(2),
  ),
  minPrice: optionalMoney,
  maxPrice: optionalMoney,
  sort: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.enum(["price", "rating", "stars"]).default("price"),
  ),
  failProvider: z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    z.enum(["atlas", "nimbus"]).optional(),
  ),
});

export type QueryInput = z.infer<typeof SearchQuerySchema>;

export type ResolvedQuery = {
  cityId: string;
  cityDisplay: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  minPrice: number | null;
  maxPrice: number | null;
  sort: Sort;
  failProvider: ProviderId | null;
  currency: "INR";
};

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new AppError(400, "INVALID_QUERY", `Invalid date ${value}`);
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (!yearText || !monthText || !dayText) {
    throw new AppError(400, "INVALID_QUERY", `Invalid date ${value}`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError(400, "INVALID_QUERY", `Invalid date ${value}`);
  }
  return date;
}

export function resolveQuery(input: QueryInput, clock: Clock): ResolvedQuery {
  const today = startOfUtcDay(clock.now());
  const checkIn = input.checkIn ? parseIsoDate(input.checkIn) : addUtcDays(today, 1);
  const checkOut = input.checkOut ? parseIsoDate(input.checkOut) : addUtcDays(checkIn, 2);
  if (checkIn < today) throw new AppError(400, "INVALID_QUERY", "checkIn cannot be in the past");
  if (checkIn > addUtcDays(today, 365)) {
    throw new AppError(400, "INVALID_QUERY", "checkIn is more than 365 days out");
  }
  if (checkOut <= checkIn) throw new AppError(400, "INVALID_QUERY", "checkOut must be after checkIn");
  const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS);
  if (nights > 30) throw new AppError(400, "INVALID_QUERY", "Stay cannot be longer than 30 nights");
  const minPrice = input.minPrice ?? null;
  const maxPrice = input.maxPrice ?? null;
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new AppError(400, "INVALID_QUERY", "minPrice cannot be greater than maxPrice");
  }
  return {
    cityId: canonicalCity(input.city),
    cityDisplay: displayCity(input.city),
    checkIn: formatIsoDate(checkIn),
    checkOut: formatIsoDate(checkOut),
    nights,
    guests: input.guests,
    minPrice,
    maxPrice,
    sort: input.sort,
    failProvider: input.failProvider ?? null,
    currency: "INR",
  };
}

/** Price filters and sort are applied on read, so they are not part of the key. */
export function cacheKey(query: ResolvedQuery): string {
  return `offers:v1:${query.cityId}:${query.checkIn}:${query.checkOut}:${query.guests}:inr`;
}
