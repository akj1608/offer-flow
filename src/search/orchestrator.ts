import type { Logger } from "pino";
import type { OfferCache } from "../cache/offer-cache.js";
import { dedupeOffers } from "../domain/dedupe.js";
import { AppError, CacheUnavailableError } from "../domain/errors.js";
import { priceStay } from "../domain/pricing.js";
import type { HotelOffer, ProviderId } from "../domain/types.js";
import { fanOut, type ProviderFailure } from "../providers/fan-out.js";
import type { HotelProvider } from "../providers/hotel-provider.js";
import { decodePayload, encodePayload, type CachedPayload } from "./payload.js";
import { cacheKey, type ResolvedQuery } from "./query.js";

export type CacheStatus = "HIT" | "MISS" | "BYPASS" | "COALESCED";

const PARTIAL_TTL_SECONDS = 30;

export type SearchResponse = {
  query: {
    city: string;
    cityId: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    guests: number;
    currency: "INR";
    minPrice: number | null;
    maxPrice: number | null;
    sort: ResolvedQuery["sort"];
  };
  meta: {
    cache: CacheStatus;
    cacheReason: string;
    cacheKey: string;
    cacheAgeSeconds: number | null;
    cacheTtlSeconds: number | null;
    offersBeforeDedupe: number;
    offersAfterDedupe: number;
    returned: number;
    providersQueried: ProviderId[];
    providersOk: ProviderId[];
    providersFailed: ProviderFailure[];
    tookMs: number;
    requestId: string;
  };
  offers: HotelOffer[];
};

type Execution = {
  cache: Exclude<CacheStatus, "COALESCED">;
  cacheReason: string;
  cacheAgeSeconds: number | null;
  cacheTtlSeconds: number | null;
  offers: HotelOffer[];
  offersBeforeDedupe: number;
  providersQueried: ProviderId[];
  providersOk: ProviderId[];
  providersFailed: ProviderFailure[];
};

export type OrchestratorOptions = {
  ttlSeconds: number;
  providerTimeoutMs: number;
  logger: Logger;
};

export class OfferOrchestrator {
  private readonly inflight = new Map<string, Promise<Execution>>();

  constructor(
    private readonly providers: readonly HotelProvider[],
    private readonly cache: OfferCache,
    private readonly options: OrchestratorOptions,
  ) {}

  async search(query: ResolvedQuery, ctx: { requestId: string }): Promise<SearchResponse> {
    const started = Date.now();
    const key = cacheKey(query);

    if (query.failProvider) {
      const loaded = await this.fetchAndMerge(query, ctx.requestId);
      return this.finish(query, loaded, {
        cache: "BYPASS",
        cacheReason: "fault_injection",
        cacheKey: key,
        cacheAgeSeconds: null,
        cacheTtlSeconds: null,
        started,
        requestId: ctx.requestId,
      });
    }

    const existing = this.inflight.get(key);
    const leader = !existing;
    const execution = existing ?? this.track(key, this.execute(key, query, ctx.requestId));
    const result = await execution;
    const joined = !leader && result.cache !== "BYPASS";
    return this.finish(query, result, {
      cache: joined ? "COALESCED" : result.cache,
      cacheReason: joined ? "joined_inflight" : result.cacheReason,
      cacheKey: key,
      cacheAgeSeconds: result.cacheAgeSeconds,
      cacheTtlSeconds: result.cacheTtlSeconds,
      started,
      requestId: ctx.requestId,
    });
  }

  private track(key: string, promise: Promise<Execution>): Promise<Execution> {
    this.inflight.set(key, promise);
    promise.then(
      () => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      },
      () => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      },
    );
    return promise;
  }

  private async execute(key: string, query: ResolvedQuery, requestId: string): Promise<Execution> {
    const log = this.options.logger.child({ requestId, cacheKey: key });
    let raw: string | null = null;
    try {
      raw = await this.cache.get(key);
    } catch (error) {
      if (error instanceof CacheUnavailableError) {
        log.warn(
          { host: error.host, port: error.port, code: error.code, err: error.message },
          "cache bypassed because redis is unreachable",
        );
        const loaded = await this.fetchAndMerge(query, requestId);
        return { ...loaded, cache: "BYPASS", cacheReason: "redis_unreachable", cacheAgeSeconds: null, cacheTtlSeconds: null };
      }
      throw error;
    }

    let corrupt = false;
    let stale = false;
    if (raw) {
      const decoded = decodePayload(raw);
      if (!decoded) {
        corrupt = true;
        log.warn({ cacheKey: key }, "cache payload failed validation");
      } else {
        const ageSeconds = ageOf(decoded.storedAt);
        if (ageSeconds < decoded.ttlSeconds) {
          log.info({ ageSeconds }, "cache hit");
          return {
            cache: "HIT",
            cacheReason: "fresh",
            cacheAgeSeconds: ageSeconds,
            cacheTtlSeconds: Math.max(0, decoded.ttlSeconds - ageSeconds),
            offers: decoded.offers,
            offersBeforeDedupe: decoded.offersBeforeDedupe,
            providersQueried: decoded.providersQueried,
            providersOk: decoded.providersOk,
            providersFailed: decoded.providersFailed,
          };
        }
        stale = true;
      }
    }

    const loaded = await this.fetchAndMerge(query, requestId);
    const ttlSeconds = chooseTtl(this.options.ttlSeconds, loaded.providersFailed.length > 0);
    const storedAt = new Date().toISOString();
    const payload: CachedPayload = {
      version: 1,
      storedAt,
      ttlSeconds,
      offersBeforeDedupe: loaded.offersBeforeDedupe,
      providersQueried: loaded.providersQueried,
      providersOk: loaded.providersOk,
      providersFailed: loaded.providersFailed,
      offers: loaded.offers,
    };
    try {
      await this.cache.set(key, encodePayload(payload), ttlSeconds);
      log.info({ ttlSeconds, offers: loaded.offers.length }, "cache store");
    } catch (error) {
      if (error instanceof CacheUnavailableError) {
        log.warn(
          { host: error.host, port: error.port, code: error.code, err: error.message },
          "cache bypassed because redis is unreachable",
        );
        return { ...loaded, cache: "BYPASS", cacheReason: "redis_unreachable", cacheAgeSeconds: null, cacheTtlSeconds: null };
      }
      throw error;
    }

    const cacheReason = corrupt ? "refreshed_corrupt" : stale ? "refreshed_stale" : "stored";
    return {
      ...loaded,
      cache: "MISS",
      cacheReason,
      cacheAgeSeconds: null,
      cacheTtlSeconds: ttlSeconds,
    };
  }

  private async fetchAndMerge(query: ResolvedQuery, requestId: string): Promise<Omit<Execution, "cache" | "cacheReason" | "cacheAgeSeconds" | "cacheTtlSeconds">> {
    const fan = await fanOut(
      this.providers,
      { city: query.cityId, failProvider: query.failProvider },
      this.options.providerTimeoutMs,
    );
    if (fan.providersFailed.length > 0) {
      this.options.logger.warn(
        { requestId, providersFailed: fan.providersFailed },
        "provider fan-out was partial or failed",
      );
    }
    if (fan.providersOk.length === 0) {
      throw new AppError(502, "PROVIDERS_UNAVAILABLE", "Every hotel provider failed", {
        providersFailed: fan.providersFailed,
      });
    }
    const priced = fan.offers.map((offer) => {
      const stay = priceStay(offer.nightlyRate, query.nights, query.guests);
      return {
        ...offer,
        amenities: [...offer.amenities],
        baseNightlyRate: offer.nightlyRate,
        nightlyRate: stay.nightlyRate,
        totalPrice: stay.totalPrice,
        nights: query.nights,
        guests: query.guests,
      };
    });
    const merged = dedupeOffers(priced);
    return {
      offers: merged.hotels,
      offersBeforeDedupe: merged.before,
      providersQueried: this.providers.map((provider) => provider.id),
      providersOk: fan.providersOk,
      providersFailed: fan.providersFailed,
    };
  }

  private finish(
    query: ResolvedQuery,
    execution: Omit<Execution, "cache" | "cacheReason" | "cacheAgeSeconds" | "cacheTtlSeconds">,
    frame: {
      cache: CacheStatus;
      cacheReason: string;
      cacheKey: string;
      cacheAgeSeconds: number | null;
      cacheTtlSeconds: number | null;
      started: number;
      requestId: string;
    },
  ): SearchResponse {
    const offers = present(execution.offers, query);
    const tookMs = Date.now() - frame.started;
    this.options.logger.info(
      {
        requestId: frame.requestId,
        city: query.cityId,
        cache: frame.cache,
        cacheReason: frame.cacheReason,
        returned: offers.length,
        tookMs,
      },
      "search completed",
    );
    return {
      query: {
        city: query.cityDisplay,
        cityId: query.cityId,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        nights: query.nights,
        guests: query.guests,
        currency: "INR",
        minPrice: query.minPrice,
        maxPrice: query.maxPrice,
        sort: query.sort,
      },
      meta: {
        cache: frame.cache,
        cacheReason: frame.cacheReason,
        cacheKey: frame.cacheKey,
        cacheAgeSeconds: frame.cacheAgeSeconds,
        cacheTtlSeconds: frame.cacheTtlSeconds,
        offersBeforeDedupe: execution.offersBeforeDedupe,
        offersAfterDedupe: execution.offers.length,
        returned: offers.length,
        providersQueried: execution.providersQueried,
        providersOk: execution.providersOk,
        providersFailed: execution.providersFailed,
        tookMs,
        requestId: frame.requestId,
      },
      offers,
    };
  }
}

function present(hotels: HotelOffer[], query: ResolvedQuery): HotelOffer[] {
  const filtered = hotels.filter((hotel) => {
    if (query.minPrice != null && hotel.totalPrice < query.minPrice) return false;
    if (query.maxPrice != null && hotel.totalPrice > query.maxPrice) return false;
    return true;
  });
  filtered.sort((left, right) => {
    if (query.sort === "rating") {
      return right.guestRating - left.guestRating || left.totalPrice - right.totalPrice || left.name.localeCompare(right.name);
    }
    if (query.sort === "stars") {
      return right.stars - left.stars || left.totalPrice - right.totalPrice || left.name.localeCompare(right.name);
    }
    return left.totalPrice - right.totalPrice || left.name.localeCompare(right.name);
  });
  return filtered;
}

function chooseTtl(baseTtl: number, partial: boolean): number {
  if (partial) return Math.min(PARTIAL_TTL_SECONDS, baseTtl);
  return baseTtl + Math.floor(Math.random() * 31);
}

function ageOf(storedAt: string): number {
  const stored = Date.parse(storedAt);
  if (Number.isNaN(stored)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - stored) / 1000));
}
