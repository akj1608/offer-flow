import { displayCity, canonicalHotelId } from "./identity.js";
import { PROVIDERS, type HotelAlternative, type HotelOffer, type PricedOffer } from "./types.js";

/**
 * Lower guest total wins. Commission is ignored on purpose: a higher commission
 * on a more expensive rate is a worse stay for the traveller.
 * Ties break toward the higher guest rating, then the provider id ascending,
 * so the same inputs always produce the same card.
 */
function compareQuotes(left: PricedOffer, right: PricedOffer): number {
  if (left.totalPrice !== right.totalPrice) return left.totalPrice - right.totalPrice;
  if (left.guestRating !== right.guestRating) return right.guestRating - left.guestRating;
  return left.provider.localeCompare(right.provider);
}

function toAlternative(offer: PricedOffer): HotelAlternative {
  return {
    provider: offer.provider,
    providerName: PROVIDERS[offer.provider],
    providerHotelId: offer.providerHotelId,
    nightlyRate: offer.nightlyRate,
    totalPrice: offer.totalPrice,
    guestRating: offer.guestRating,
    commissionPct: offer.commissionPct,
  };
}

export function dedupeOffers(offers: PricedOffer[]): { hotels: HotelOffer[]; before: number } {
  const groups = new Map<string, PricedOffer[]>();
  for (const offer of offers) {
    const hotelId = canonicalHotelId(offer.city, offer.name);
    const group = groups.get(hotelId);
    if (group) group.push(offer);
    else groups.set(hotelId, [offer]);
  }

  const hotels: HotelOffer[] = [];
  for (const [hotelId, group] of groups) {
    const ranked = group.slice().sort(compareQuotes);
    const winner = ranked[0];
    if (!winner) continue;
    const alternatives = ranked.slice(1).map(toAlternative);
    const next = alternatives[0];
    hotels.push({
      hotelId,
      name: winner.name,
      city: displayCity(winner.city),
      stars: winner.stars,
      guestRating: winner.guestRating,
      board: winner.board,
      refundable: winner.refundable,
      amenities: [...winner.amenities],
      nights: winner.nights,
      guests: winner.guests,
      nightlyRate: winner.nightlyRate,
      totalPrice: winner.totalPrice,
      currency: "INR",
      provider: winner.provider,
      providerName: PROVIDERS[winner.provider],
      providerHotelId: winner.providerHotelId,
      commissionPct: winner.commissionPct,
      savingsVsNext: next ? next.totalPrice - winner.totalPrice : 0,
      alternatives,
    });
  }

  return { hotels, before: offers.length };
}
