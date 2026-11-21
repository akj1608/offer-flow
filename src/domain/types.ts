export const PROVIDERS = {
  atlas: "Atlas Beds",
  nimbus: "Nimbus Stays",
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export type Board = "room-only" | "breakfast" | "half-board";

export type Sort = "price" | "rating" | "stars";

/** A quote as a provider listed it, before occupancy and stay length are applied. */
export type RawOffer = {
  provider: ProviderId;
  providerHotelId: string;
  name: string;
  city: string;
  stars: 3 | 4 | 5;
  guestRating: number;
  nightlyRate: number;
  commissionPct: number;
  refundable: boolean;
  board: Board;
  amenities: string[];
};

/** Raw offer priced for a specific stay. `nightlyRate` is occupancy-adjusted. */
export type PricedOffer = Omit<RawOffer, "nightlyRate"> & {
  baseNightlyRate: number;
  nightlyRate: number;
  totalPrice: number;
  nights: number;
  guests: number;
};

export type HotelAlternative = {
  provider: ProviderId;
  providerName: string;
  providerHotelId: string;
  nightlyRate: number;
  totalPrice: number;
  guestRating: number;
  commissionPct: number;
};

export type HotelOffer = {
  hotelId: string;
  name: string;
  city: string;
  stars: 3 | 4 | 5;
  guestRating: number;
  board: Board;
  refundable: boolean;
  amenities: string[];
  nights: number;
  guests: number;
  nightlyRate: number;
  totalPrice: number;
  currency: "INR";
  provider: ProviderId;
  providerName: string;
  providerHotelId: string;
  commissionPct: number;
  savingsVsNext: number;
  alternatives: HotelAlternative[];
};
