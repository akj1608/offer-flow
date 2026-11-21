/**
 * Identity is exact, plus a short alias table.
 * Fuzzy matching is intentionally absent: a false merge hides a real hotel.
 */

const NAME_ALIASES: Record<string, string> = {
  "oberoi-new-delhi": "the-oberoi",
  "taj-mahal-hotel-new-delhi": "taj-mahal-hotel",
  "taj-mahal-palace-hotel": "the-taj-mahal-palace",
  "itc-windsor-bengaluru": "itc-windsor",
  "fort-aguada-beach-resort": "fort-aguada",
};

const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru",
  bombay: "mumbai",
  "new-delhi": "delhi",
  newdelhi: "delhi",
};

const CITY_DISPLAY: Record<string, string> = {
  delhi: "Delhi",
  mumbai: "Mumbai",
  bengaluru: "Bengaluru",
  goa: "Goa",
};

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function canonicalCity(input: string): string {
  const slug = slugify(input);
  return CITY_ALIASES[slug] ?? slug;
}

export function displayCity(input: string): string {
  const key = canonicalCity(input);
  const known = CITY_DISPLAY[key];
  if (known) return known;
  return key
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function canonicalHotelId(city: string, name: string): string {
  const nameSlug = slugify(name);
  const canonicalName = NAME_ALIASES[nameSlug] ?? nameSlug;
  return `${canonicalCity(city)}:${canonicalName}`;
}
