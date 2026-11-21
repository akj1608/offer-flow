# Offer Desk

Hotel Offer Orchestrator. A Node.js service that asks two mock suppliers for a stay, collapses the same hotel to one card, and keeps the cheaper quote. The merged result is cached in Redis. If Redis cannot be reached, search still answers and says so.

The desk is the page at `/`. The contract the assessment cares about is `GET /v1/offers`.

## What a search does

1. Read Redis. The key is the city, the dates, and the guest count. Price filters and sort are not in the key.
2. On a hit, filter and sort in process. The suppliers are not called. The response header is `X-Cache: HIT`.
3. On a miss, call Atlas Beds and Nimbus Stays together, price the stay, and dedupe.
4. Store the merged list with a TTL (15 minutes, plus up to 30 seconds of jitter). The response header is `X-Cache: MISS`.
5. If Redis is down, skip the cache, log the host, port, and error code, and answer anyway. The header is `X-Cache: BYPASS`.

The Oberoi is listed twice under different names. Atlas calls it "Oberoi New Delhi" at ₹9,250 a night. Nimbus calls it "The Oberoi" at ₹8,600. For two nights and two guests the card is Nimbus, ₹17,200 total, with Atlas kept as the losing quote, ₹1,300 more.

Commission does not pick the winner. Sunder Nagar House is the proof: Atlas is cheaper and pays less commission, and Atlas still wins.

## Run it

Node.js 22 or newer.

```bash
npm install
npm test
npm run dev
```

The API listens on port **4781**.

Redis is optional for the process to boot, and required if you want hits.

```bash
redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --save "" --appendonly no
redis-cli ping
```

Or, with Docker:

```bash
docker compose up --build
```

Open `http://127.0.0.1:4781`.

## Prove the cache

Start Redis, start the API, then:

```bash
npm run verify:cache
```

That deletes one key, searches Delhi, and expects `MISS` then `HIT`. It also checks that Nimbus won The Oberoi and that the JSON is actually in Redis.

By hand:

```bash
curl -sD - -o /tmp/offers.json "http://127.0.0.1:4781/v1/offers?city=delhi&checkIn=2026-12-02&checkOut=2026-12-05&guests=2"
curl -sD - -o /dev/null "http://127.0.0.1:4781/v1/offers?city=delhi&checkIn=2026-12-02&checkOut=2026-12-05&guests=2"
```

The first response carries `X-Cache: MISS` and `X-Cache-Reason: stored`. The second carries `X-Cache: HIT` and `X-Cache-Reason: fresh`.

PowerShell:

```powershell
$r = Invoke-WebRequest "http://localhost:4781/v1/offers?city=delhi&checkIn=2026-12-02&checkOut=2026-12-05&guests=2"
$r.Headers["X-Cache"]
$r.Headers["X-Cache-Reason"]
Test-NetConnection -ComputerName 127.0.0.1 -Port 6379
```

If caching is being skipped, the log line is:

```text
cache bypassed because redis is unreachable
```

It includes `host`, `port`, and `code` (usually `ECONNREFUSED`). Check the port:

```bash
nc -z 127.0.0.1 6379 && echo open || echo closed
```

`GET /health` stays HTTP 200 when Redis is down, with `"status": "degraded"`. Search is fail-open on purpose.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/offers` | Search, merge, cache |
| `GET` | `/v1/providers` | Supplier names and cities |
| `GET` | `/health` | Process and Redis |
| `GET` | `/` | Offer Desk |

Query on `/v1/offers`:

| Param | Notes |
| --- | --- |
| `city` | Required. `Bangalore` is treated as Bengaluru. |
| `checkIn`, `checkOut` | `YYYY-MM-DD`, UTC. Default is tomorrow and two nights. Max 30 nights. |
| `guests` | 1–8, default 2. The nightly rate covers two guests. Each guest after that adds 15%. |
| `minPrice`, `maxPrice` | Inclusive filter on the **total** stay, applied after the cache read. |
| `sort` | `price` (default), `rating`, or `stars`. Also applied after the cache read. |
| `failProvider` | `atlas` or `nimbus`. Forces a bypass and does not write Redis. |

Headers on every search: `X-Cache` (`HIT`, `MISS`, `BYPASS`, `COALESCED`), `X-Cache-Reason`, `X-Cache-Key`, `X-Cache-Age` on hits, `X-Offers-Before-Dedupe`, `X-Offers-After-Dedupe`, `X-Providers-Ok`, `X-Providers-Failed`, `X-Request-Id`, `X-Response-Time-Ms`, `Cache-Control: no-store`.

`COALESCED` means this process joined an in-flight miss for the same key instead of calling the suppliers again. That lock is per process, not across replicas.

Errors: `400 INVALID_QUERY`, `404 NOT_FOUND`, `502 PROVIDERS_UNAVAILABLE`, `500 INTERNAL`.

```json
{ "error": { "code": "INVALID_QUERY", "message": "checkOut must be after checkIn", "details": null, "requestId": "…" } }
```

## Layout

```text
src/server.ts                 boot, Redis ping, shutdown
src/http/app.ts               routes, headers, Offer Desk files
src/search/orchestrator.ts    cache, singleflight, fan-out, response
src/search/query.ts           validation, dates, cache key
src/search/payload.ts         versioned cache JSON
src/domain/dedupe.ts          cheaper quote wins
src/domain/identity.ts        city and hotel aliases
src/domain/pricing.ts         guests and nights
src/catalog/hotels.ts         Atlas and Nimbus inventory
src/providers/fan-out.ts      parallel calls with a hard timeout
src/cache/redis-cache.ts      fail-fast Redis
public/                       Offer Desk
docs/                         architecture, flow, operations, OpenAPI
```

## Decisions worth defending

- **Fail open.** A cache outage must not take down search. The header and the log say why the cache was skipped.
- **Guest price wins, not commission.** The product is a stay, not a margin sort.
- **Aliases, not fuzzy match.** A wrong merge hides a hotel. The alias table is explicit and small.
- **Cache the merged stay, not the raw supplier payloads.** Filters and sort are cheap and must not split the key.
- **Short TTL when a supplier failed.** A 15 minute cache of a partial result would hide a supplier that recovers. Total failure is not cached at all.
- **In-process suppliers behind one interface.** The mocks are not HTTP calls back into this process. A real supplier adapter would implement the same interface.
- **No distributed lock, and no pretend one.** Singleflight is in-memory. A `SET NX` lock is the multi-replica follow-up.

More detail, including sequence diagrams, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/FLOW.md](docs/FLOW.md), and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Environment

| Variable | Default |
| --- | --- |
| `PORT` | `4781` |
| `HOST` | `0.0.0.0` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `CACHE_TTL_SECONDS` | `900` |
| `PROVIDER_TIMEOUT_MS` | `800` |
| `MOCK_LATENCY_MS` | `120` |
| `LOG_LEVEL` | `info` |
| `NODE_ENV` | `development` |

See `.env.example`. A variable already set in the shell wins over `.env`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Reload on change |
| `npm test` | Unit, HTTP, and Redis integration when Redis is up |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the build |
| `npm run verify:cache` | Live MISS then HIT against a running server |
