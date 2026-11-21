import { ProviderError, errorMessage } from "../domain/errors.js";
import type { ProviderId, RawOffer } from "../domain/types.js";
import type { HotelProvider, ProviderQuery } from "./hotel-provider.js";

export type ProviderFailure = {
  provider: ProviderId;
  message: string;
};

export type FanOutResult = {
  offers: RawOffer[];
  providersOk: ProviderId[];
  providersFailed: ProviderFailure[];
};

function failureMessage(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && (error.name === "AbortError" || error.message === "aborted")) return "timed out";
  return errorMessage(error).slice(0, 200);
}

/**
 * Ask every provider at once. A provider that ignores the abort signal still
 * cannot hold the search: Promise.race returns at the timeout, and a late
 * rejection is swallowed so it does not surface as unhandled.
 */
export async function fanOut(
  providers: readonly HotelProvider[],
  query: ProviderQuery,
  timeoutMs: number,
): Promise<FanOutResult> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderError(provider.id, "timed out"));
        }, timeoutMs);
      });
      const searchPromise = provider.search(
        { city: query.city, failProvider: query.failProvider },
        controller.signal,
      );
      searchPromise.then(
        () => undefined,
        () => undefined,
      );
      try {
        const offers = await Promise.race([searchPromise, timeout]);
        return { ok: true as const, provider: provider.id, offers };
      } catch (error) {
        return { ok: false as const, provider: provider.id, message: failureMessage(error) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );

  const offers: RawOffer[] = [];
  const providersOk: ProviderId[] = [];
  const providersFailed: ProviderFailure[] = [];
  for (const result of results) {
    if (result.ok) {
      providersOk.push(result.provider);
      offers.push(...result.offers);
    } else {
      providersFailed.push({ provider: result.provider, message: result.message });
    }
  }
  return { offers, providersOk, providersFailed };
}
