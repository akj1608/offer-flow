import { CATALOG } from "../catalog/hotels.js";
import { ProviderError } from "../domain/errors.js";
import { canonicalCity } from "../domain/identity.js";
import { PROVIDERS, type ProviderId, type RawOffer } from "../domain/types.js";
import type { HotelProvider, ProviderQuery } from "./hotel-provider.js";
import { sleep } from "./sleep.js";

export class MockHotelProvider implements HotelProvider {
  readonly displayName: string;

  constructor(
    readonly id: ProviderId,
    private readonly latencyMs: number,
  ) {
    this.displayName = PROVIDERS[id];
  }

  async search(query: ProviderQuery, signal: AbortSignal): Promise<RawOffer[]> {
    if (signal.aborted) throw new ProviderError(this.id, "timed out");
    if (query.failProvider === this.id) throw new ProviderError(this.id, "injected failure");
    if (this.latencyMs > 0) await sleep(this.latencyMs, signal);
    const city = canonicalCity(query.city);
    return CATALOG.filter((hotel) => hotel.provider === this.id && canonicalCity(hotel.city) === city).map(
      (hotel) => ({ ...hotel, amenities: [...hotel.amenities] }),
    );
  }
}
