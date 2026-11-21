import { Redis } from "ioredis";

const base = process.env.BASE_URL ?? "http://127.0.0.1:4781";
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const params = new URLSearchParams({
  city: "delhi",
  checkIn: "2026-12-02",
  checkOut: "2026-12-05",
  guests: "2",
});
const key = "offers:v1:delhi:2026-12-02:2026-12-05:2:inr";

type Offer = {
  hotelId: string;
  provider: string;
  totalPrice: number;
  savingsVsNext: number;
};

type SearchBody = {
  offers?: Offer[];
  error?: { message?: string };
};

const redis = new Redis(redisUrl, {
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
});

try {
  await redis.connect();
  const pong = await redis.ping();
  if (pong !== "PONG") throw new Error(`unexpected ping reply ${pong}`);
  await redis.del(key);
} catch (error) {
  console.error("Redis is not reachable, so the API will bypass the cache.");
  console.error("Start Redis, then run this again. Port check: nc -z 127.0.0.1 6379");
  console.error(error instanceof Error ? error.message : error);
  try {
    redis.disconnect();
  } catch {
    // already closed
  }
  process.exit(2);
}

async function hit(): Promise<{ status: number; cache: string | null; reason: string | null; body: SearchBody }> {
  let response: Response;
  try {
    response = await fetch(`${base}/v1/offers?${params}`);
  } catch (error) {
    console.error(`Could not reach ${base}. Start the API first.`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
  const body = (await response.json()) as SearchBody;
  return {
    status: response.status,
    cache: response.headers.get("x-cache"),
    reason: response.headers.get("x-cache-reason"),
    body,
  };
}

const first = await hit();
const second = await hit();
console.log(`first  X-Cache=${first.cache} reason=${first.reason} status=${first.status}`);
console.log(`second X-Cache=${second.cache} reason=${second.reason} status=${second.status}`);

const oberoi = (first.body.offers ?? []).find((offer) => offer.hotelId === "delhi:the-oberoi");
const stored = await redis.get(key);
await redis.quit();

let failed = false;
if (first.cache !== "MISS" || second.cache !== "HIT") {
  console.error("Expected the first request to store (MISS) and the second to read (HIT).");
  failed = true;
}
if (!oberoi || oberoi.provider !== "nimbus" || oberoi.savingsVsNext <= 0) {
  console.error("Expected Nimbus to win The Oberoi on price.", oberoi);
  failed = true;
}
if (!stored || !stored.includes("delhi:the-oberoi")) {
  console.error("Expected Redis to hold the merged Oberoi offer under", key);
  failed = true;
}
if (failed) process.exit(1);

console.log(
  `Oberoi winner ${oberoi.provider} total INR ${oberoi.totalPrice}, saved INR ${oberoi.savingsVsNext} versus the next quote.`,
);
console.log("Cache round-trip verified.");
