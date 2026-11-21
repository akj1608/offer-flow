/**
 * The published nightly rate covers one or two guests.
 * Each further guest adds 15 percent, rounded to the rupee on the nightly rate,
 * then multiplied by the number of nights. Both providers are priced with this
 * rule before they are compared, so the cheaper base rate stays the cheaper stay.
 */
export function adjustNightlyRate(baseNightlyRate: number, guests: number): number {
  const extraGuests = Math.max(0, guests - 2);
  const multiplier = 1 + extraGuests * 0.15;
  return Math.round(baseNightlyRate * multiplier);
}

export function priceStay(
  baseNightlyRate: number,
  nights: number,
  guests: number,
): { nightlyRate: number; totalPrice: number } {
  const nightlyRate = adjustNightlyRate(baseNightlyRate, guests);
  return { nightlyRate, totalPrice: nightlyRate * nights };
}
