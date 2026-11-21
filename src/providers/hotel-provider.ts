import type { ProviderId, RawOffer } from "../domain/types.js";

export type ProviderQuery = {
  city: string;
  failProvider: ProviderId | null;
};

export interface HotelProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  search(query: ProviderQuery, signal: AbortSignal): Promise<RawOffer[]>;
}
