# Offer Desk

Offer Desk is a hotel offer orchestrator: one Node.js / TypeScript (ESM) Fastify process. It asks two providers for quotes, prices every stay with the same occupancy rule, merges quotes for the same hotel, keeps the cheaper stay, and stores that merged document in Redis.

The process listens on port 4781. Redis defaults to `redis://127.0.0.1:6379`. Full results live for 900 seconds plus up to 30 seconds of jitter. A partial provider failure lives for 30 seconds. A total provider failure is not stored. Redis is the only network dependency. Both providers run in-process. Callers are not authenticated.

These notes are the contract the code implements.

## Components

```mermaid
flowchart LR
  browser[Browser]
  curlCli[curl]
  fastify[Fastify]
  orchestrator[OfferOrchestrator]
  offerCache[OfferCache]
  redis[("Redis")]
  fanout[FanOut]
  atlas["Atlas Beds"]
  nimbus["Nimbus Stays"]
  dedupe[Dedupe]

  browser --> fastify
  curlCli --> fastify
  fastify --> orchestrator
  orchestrator -->|"get and set"| offerCache
  offerCache --> redis
  orchestrator --> fanout
  fanout --> atlas
  fanout --> nimbus
  orchestrator -->|"priced quotes"| dedupe
```

The browser and curl hit Fastify. Fastify validates the query and calls `OfferOrchestrator`. The orchestrator reads and writes through `OfferCache`, and `OfferCache` talks to Redis.

On a miss, a Redis failure, or a corrupt document, the orchestrator calls `FanOut`. Fan-out calls Atlas Beds (`atlas`) and Nimbus Stays (`nimbus`) in parallel. Each adapter implements `HotelProvider`. The default adapters are in-process mocks: a function call, a latency timer, and a per-provider timeout (default 800ms). They are not HTTP calls back into this process. A real supplier adapter implements the same interface and replaces a mock without a change to pricing, dedupe, or the cache key.

The orchestrator prices the quotes, then passes them to dedupe. Dedupe groups them by hotel identity and picks a winner.

## Modules

```
src/server.ts
src/config.ts
src/logger.ts
src/http/app.ts
src/search/query.ts
src/search/payload.ts
src/search/orchestrator.ts
src/domain/dedupe.ts
src/domain/identity.ts
src/domain/pricing.ts
src/domain/types.ts
src/domain/errors.ts
src/catalog/hotels.ts
src/providers/hotel-provider.ts
src/providers/mock-provider.ts
src/providers/fan-out.ts
src/cache/offer-cache.ts
src/cache/memory-cache.ts
src/cache/redis-cache.ts
public/
```

`server.ts` loads config, builds the app, listens, and on `SIGINT` or `SIGTERM` closes Fastify and then the Redis client. `config.ts` reads the environment and refuses to boot on a bad value. `logger.ts` is the pino logger. The Redis warning fields are fixed there.

`http/app.ts` builds Fastify, registers the routes, serves `public/` at `/`, and turns thrown errors into the error body. The error handler logs the stack and sends a fixed message.

`search/query.ts` parses the query, fills defaults, and canonicalizes the city. `search/payload.ts` writes the JSON body and the response headers from one result object. `search/orchestrator.ts` owns the cache read, singleflight, fan-out, write policy, and per-request filter.

`domain/pricing.ts` applies occupancy. `domain/identity.ts` applies the alias tables and builds `hotelId`. `domain/dedupe.ts` groups quotes and picks the winner. `domain/types.ts` holds the shared types. `domain/errors.ts` defines `INVALID_QUERY`, `NOT_FOUND`, `PROVIDERS_UNAVAILABLE`, and `INTERNAL`.

`catalog/hotels.ts` is the fixed mock list. Both adapters read it. Rates do not vary by date. The date still enters the cache key so two stays cannot collide, and so a later supplier adapter can return different prices for different dates without a key change.

`providers/hotel-provider.ts` is the interface. `mock-provider.ts` is Atlas Beds and Nimbus Stays. `fan-out.ts` runs them in parallel and enforces the timeout. `failProvider` is applied here as an immediate failure of that provider, before its latency timer starts.

`cache/offer-cache.ts` is the port the orchestrator calls: get, set, TTL choice, and corrupt detection. `redis-cache.ts` is the production adapter. `memory-cache.ts` is the same get/set port backed by a `Map`, including per-key expiry. Unit tests construct the memory adapter directly. Production wires Redis. A failed Redis command ends the cache attempt for that request.

`public/` is the Offer Desk UI, static files with no build step. `public/index.html` is `GET /`.

## Request path

1. `query.ts` validates the query. A failure returns 400 and stops. Defaults and the city alias run only after validation.
2. The orchestrator builds `offers:v1:{city}:{checkIn}:{checkOut}:{guests}:inr`.
3. A request with `failProvider` skips Redis and skips singleflight. It fans out on its own.
4. Otherwise the orchestrator enters singleflight, and the leader calls `OfferCache`.
5. A valid document is filtered and sorted in the request and returned as `HIT`. Providers are not called.
6. A miss, a corrupt document, or a Redis error fans out. `pricing.ts` runs on every returned quote. `dedupe.ts` merges them.
7. The leader writes Redis only when the write rules below allow it.
8. The route copies cache status, reason, key, and age onto the response headers and onto `meta` (`cache`, `cacheReason`, `cacheKey`, `cacheAgeSeconds`).

Price filters and the result sort run per request, after the shared document exists. Joiners on one flight can carry different `minPrice`, `maxPrice`, and `sort`. Those values are not in the key, and they do not split the flight.

## Decisions

### 1. Fail-open cache

If Redis cannot be reached, the search still returns offers. The response carries `X-Cache: BYPASS` and `X-Cache-Reason: redis_unreachable`. The process logs a warning. The warning includes the host, the port, and the error code (`ECONNREFUSED` when nothing is listening). Operators then check that port. The log line is specified in `OPERATIONS.md`.

The offline queue is disabled, so a command is not parked until Redis returns. Connect timeout and command timeout are each 300ms. Those timeouts are constants in `redis-cache.ts`, not environment variables. `maxRetriesPerRequest` is 1, and a dead socket is replaced once. If that second attempt fails, the search proceeds. The request does not block on the background reconnect loop.

A `GET` that fails is enough to take the bypass path. The leader then skips `SET`. If `GET` was a miss and the following `SET` fails, the process logs the same warning and still answers `BYPASS`. The offers are the live fan-out. The key remains absent.

The host and port in the log are parsed from `REDIS_URL`. Userinfo from the URL is never logged. When the error carries no code, the field is `REDIS_UNAVAILABLE`. `ioredis` is configured with `enableOfflineQueue: false`, `connectTimeout` and `commandTimeout` of 300ms, and `maxRetriesPerRequest: 1`. A dead client is replaced and the command is attempted once more. A second failure becomes the bypass. The request does not sit in the reconnect loop.

### 2. The cheaper stay wins

The winner is the lower guest total after occupancy pricing. A tie breaks to the higher `guestRating`, then to the provider id in ascending order (`atlas` before `nimbus`). Commission is stored on the quote as `commissionPct` and is not an input to the ranking.

Optimizing commission would pick a worse price for the traveller, which this service refuses to do. The catalog case is Sunder Nagar House in Delhi, two nights, two guests. Atlas is ₹4,000 a night at 5% commission, total ₹8,000. Nimbus is ₹4,500 a night at 25% commission, total ₹9,000. The card is Atlas. A desk that maximized `commissionPct` would sell the Nimbus stay and charge the traveller ₹1,000 more.

The winner card keeps the losing quotes on `alternatives`, in the same comparator order. `savingsVsNext` is the runner-up `totalPrice` minus the winner `totalPrice`. It is `0` when the hotel was quoted once, and `0` when the totals tie and the rating or the provider id decided the winner. Ratings are not averaged across providers. The card shows the winner's stars and `guestRating`. The card `name` is the winning quote's listed name. The alias is visible in `hotelId`, not as a separate listed-name field.

### 3. Identity is an alias table plus a slug

A hotel id is a canonical city plus a slugged hotel name: `delhi:the-oberoi`.

Normalization, in `identity.ts`:

1. Slug the raw string: trim, lowercase, turn `&` into ` and `, replace every other run outside `a-z` and `0-9` with one hyphen, and strip hyphens at the ends.
2. If that slug is in the city table, replace it. `new-delhi` and `newdelhi` both become `delhi`.
3. If the hotel-name slug is in the hotel table, replace it. `oberoi-new-delhi` becomes `the-oberoi`.
4. `hotelId` is `{citySlug}:{nameSlug}`.

The cache key uses the city slug, so `New Delhi`, `new delhi`, and `Delhi` share `delhi`.

City aliases:

| Input | Canonical |
| --- | --- |
| Bangalore | Bengaluru |
| Bombay | Mumbai |
| New Delhi | Delhi |

Hotel aliases:

| Listed name | Canonical name |
| --- | --- |
| Oberoi New Delhi | The Oberoi |
| Taj Mahal Hotel New Delhi | Taj Mahal Hotel |
| Taj Mahal Palace Hotel | The Taj Mahal Palace |
| ITC Windsor Bengaluru | ITC Windsor |
| Fort Aguada Beach Resort | Fort Aguada |

`The Oberoi` slugs to `the-oberoi`. `Taj Mahal Hotel` slugs to `taj-mahal-hotel`. `The Taj Mahal Palace` slugs to `the-taj-mahal-palace`. `ITC Windsor` slugs to `itc-windsor`. `Fort Aguada` slugs to `fort-aguada`.

A name that misses the table keeps its own slug. `The Oberoi New Delhi` slugs to `the-oberoi-new-delhi`, which is not `oberoi-new-delhi`, so it does not merge with `The Oberoi`. Fuzzy matching is out of scope because a false merge is worse than a duplicate listing.

The mock returns only rows whose canonical city equals the query. Dedupe then groups that list.

### 4. Filters stay off the cache key

`minPrice`, `maxPrice`, and `sort` are applied after the cache read, in the process, on the merged cards. They are not part of the cache key.

```
offers:v1:{city}:{checkIn}:{checkOut}:{guests}:inr
```

`city` is the canonical city slug. `checkIn` and `checkOut` are `YYYY-MM-DD`. `guests` is the integer guest count. The suffix `inr` is the currency slot. This version prices only INR and accepts no currency parameter.

The bounds are inclusive and apply to the winner's stay total. A card inside the range still carries alternatives whose totals fall outside it. A loser is not promoted into its own card when the winner is filtered out. An empty filter result is HTTP 200 with `offers: []`. The stored document still holds the full merge, so a wider filter on the next request is a hit and returns the cards the first response hid.

`sort` reorders cards after the filter:

| `sort` | Order |
| --- | --- |
| `price` (default) | `totalPrice` ascending, `name` ascending |
| `rating` | `guestRating` descending, `totalPrice` ascending, `name` ascending |
| `stars` | stars descending, `totalPrice` ascending, `name` ascending |

`name` order is `localeCompare`. This sort is not the winner comparator. The winner comparator still breaks ties on `guestRating`, then provider id. The same document then produces the same card order on a hit and on a miss.

### 5. One occupancy rule, applied before compare

The nightly rate covers 1 or 2 guests. Each guest past 2 adds 15% to the nightly rate. The uplifted nightly rate is rounded to the rupee, then multiplied by nights. Both providers are priced with this rule before comparison. A provider quote carries the base nightly rate and does not carry a total. `pricing.ts` is the only place a total is born, so an adapter cannot smuggle a second occupancy rule into the compare.

```
extra = max(0, guests - 2)
nightlyRate = round(baseNightlyRate * (1 + 0.15 * extra))
totalPrice = nightlyRate * nights
```

`round` is half away from zero for positive amounts, which is JavaScript `Math.round` on a positive number. Base catalog rates are whole rupees, so 1 or 2 guests need no rounding. The stay total is not rounded a second time. On the wire, `nightlyRate` is this adjusted rate and `totalPrice` is the stay total. `FLOW.md` runs the rule on The Oberoi, including a 3-guest case where rounding and then multiplying differs from multiplying and then rounding.

### 6. One provider interface, two in-process mocks

```ts
interface HotelProvider {
  readonly id: "atlas" | "nimbus";
  readonly displayName: string;
  search(query: { city: string; failProvider: "atlas" | "nimbus" | null }, signal: AbortSignal): Promise<RawOffer[]>;
}
```

The query carries the city slug and the fault-injection flag. Dates, nights, and guests stay in the orchestrator. A `RawOffer` is a catalog row: listed name, city, stars, `guestRating`, base `nightlyRate`, `commissionPct`, board, refundable, amenities, and `providerHotelId`.

Atlas Beds is registered first, Nimbus Stays second. `providersOk` and `providersFailed` follow that order. Winner selection uses the price comparator, not registration order.

The mock waits `MOCK_LATENCY_MS` (default 120) and then returns the catalog rows for that city. The base rate does not depend on `guests`. The fan-out races each call against `PROVIDER_TIMEOUT_MS` (default 800) with an `AbortSignal`. A timeout fails that provider with message `timed out` and clears its timer. The other provider is left to finish. Wall time is the slower of the two, capped by the timeout.

`failProvider` makes that mock throw `injected failure` before the latency sleep. Any provider failure logs a warning, message `provider fan-out was partial or failed`, with the `providersFailed` array.

### 7. Singleflight is in-process

Concurrent misses for one key share one fan-out. The map lives in the orchestrator: cache key to the leader's promise. It is updated synchronously, before the caller awaits, so two misses cannot both walk past the check and both call the providers. The entry is deleted when the promise settles. The map stores no offer bytes after that. A restart drops it. Keys that Redis still holds are hits on the next request.

The leader reports `MISS` when it writes, `HIT` when the document is already valid, or `BYPASS` when Redis cannot be used. A waiter reports `COALESCED` and `joined_inflight` when that leader result is `MISS` or `HIT`, then applies its own filter and sort. A waiter on a bypass flight reports `BYPASS` and `redis_unreachable`, the same status as the leader. A flight that throws, because both providers failed, rejects for every waiter. The error handler answers 502 and does not set `X-Cache`.

This does not coordinate across replicas. A multi-instance lock (`SET NX`) is a follow-up, not something the code pretends to do. Two replicas can both miss and both write. The last writer wins. Both documents are valid merges for the same key. `failProvider` does not join the flight and does not write, so a demo failure cannot land in the key the other replica is filling.

### 8. `failProvider` bypasses the cache

`failProvider` is a fault-injection switch with values `atlas` or `nimbus`. The request does not read Redis and does not write Redis, so a demo failure cannot poison the key. The response is `X-Cache: BYPASS` and `X-Cache-Reason: fault_injection`. There is no Redis warning. The other provider is called normally. If it returns quotes, the HTTP status is 200 and the injected id is listed in `X-Providers-Failed`. If the other provider fails as well, the status is 502 and the key is still untouched.

This path is separate from an organic partial failure. An organic single-provider failure is stored for 30 seconds. An injected failure is not stored at all.

### 9. Corrupt payloads are refreshed

A Redis value is corrupt when it is not JSON or when it fails the payload schema: `version` must be `1`, `storedAt` a string, `ttlSeconds` a positive integer, the provider arrays present, and `offers` an array of hotel cards. Unknown fields are stripped by the schema parse and the value is accepted.

A corrupt value is a miss. The leader fans out, and on a successful merge it overwrites the key. The response is `X-Cache: MISS` and `X-Cache-Reason: refreshed_corrupt`. The process logs a warning, message `cache payload failed validation`, field `cacheKey`. The raw bytes stay out of the log.

A document whose age is greater than or equal to its own `ttlSeconds` is not corrupt. It is stale. The response is `MISS` / `refreshed_stale`, and the key is overwritten. Redis `EX` usually drops the key first. `refreshed_stale` covers a value that is still present past the TTL recorded inside it.

If that fan-out fails for both providers, the handler throws before any cache write. The HTTP status is 502 `PROVIDERS_UNAVAILABLE`, and `X-Cache` is not set. The corrupt bytes are left in place. The next request tries the refresh again. `refreshed_corrupt` is reserved for a response that actually overwrote the key.

### 10. Health is fail-open

`GET /health` returns HTTP 200. `status` is `ok` when `redis.ok` is true and `degraded` when the ping failed. The body also carries `service` (`hotel-offer-orchestrator`), `redis.latencyMs`, `redis.code` when the ping failed, and `uptimeSeconds`. The ping uses the same 300ms command timeout. Readiness does not require Redis, because search is designed to run without it. A load balancer that only checks the status code keeps sending traffic while the pill is down.

Health reports the ping result in the body. It does not emit `cache bypassed because redis is unreachable` on every scrape. The search path emits that warning when a user request actually bypasses the cache.

## Cache record

The key is `offers:v1:{city}:{checkIn}:{checkOut}:{guests}:inr`. Example, for the worked Delhi stay:

```
offers:v1:delhi:2026-11-22:2026-11-24:2:inr
```

The value is UTF-8 JSON. `redis-cli GET` can print it. Raw provider payloads are not stored. A shape change bumps the key prefix and `version` together (`offers:v2`, `version: 2`).

```json
{
  "version": 1,
  "storedAt": "2026-11-21T06:40:12.000Z",
  "ttlSeconds": 914,
  "offersBeforeDedupe": 10,
  "providersQueried": ["atlas", "nimbus"],
  "providersOk": ["atlas", "nimbus"],
  "providersFailed": [],
  "offers": [
    {
      "hotelId": "delhi:the-oberoi",
      "name": "The Oberoi",
      "city": "Delhi",
      "stars": 5,
      "guestRating": 9.4,
      "board": "breakfast",
      "refundable": true,
      "amenities": ["pool", "spa", "club-lounge"],
      "nights": 2,
      "guests": 2,
      "nightlyRate": 8600,
      "totalPrice": 17200,
      "currency": "INR",
      "provider": "nimbus",
      "providerName": "Nimbus Stays",
      "providerHotelId": "nb-dl-8841",
      "commissionPct": 12,
      "savingsVsNext": 1300,
      "alternatives": [
        {
          "provider": "atlas",
          "providerName": "Atlas Beds",
          "providerHotelId": "atl-dl-440",
          "nightlyRate": 9250,
          "totalPrice": 18500,
          "guestRating": 9.2,
          "commissionPct": 10
        }
      ]
    }
  ]
}
```

`storedAt` is UTC. `ttlSeconds` is the TTL sent to Redis on that write. A full Delhi stay stores ten quotes merged into six cards (`offersBeforeDedupe` 10). The element above is The Oberoi. The other five cards use the same object. `offers` is the full merge, before price filters and before result sort. `providersFailed` entries are `{ provider, message }`. The arithmetic for this card is in `FLOW.md`.

Write rules:

| Outcome | Write | TTL |
| --- | --- | --- |
| Both providers returned (including a legitimate empty list) | `SET` key payload `EX` ttl | `CACHE_TTL_SECONDS` plus a uniform integer from 0 through 30 inclusive. Default 900, so the stored TTL is 900–930. |
| One provider failed, the other returned | `SET` | `min(30, CACHE_TTL_SECONDS)`. Jitter is not added. The reason is still `stored`. |
| Both providers failed | none | — |
| `failProvider` set | none | — |
| Redis error on `GET` or `SET` | none | — |
| Corrupt value, merge succeeded | `SET` overwrites the key | Full or partial TTL, from the row above |

A hit inside the 30-second partial window does not retry the failed provider. The short TTL is how the hole closes. After expiry the next request is a miss and fans out again.

`X-Offers-Before-Dedupe` and `X-Offers-After-Dedupe` repeat `offersBeforeDedupe` and `offersAfterDedupe`. They describe the merge, not the filtered page. `meta.returned` is the count after the filter, and it is per request. On a hit, `meta.cacheTtlSeconds` is the remaining TTL, not the original write.

## HTTP

| Method and path | Response |
| --- | --- |
| `GET /` | Offer Desk UI (`text/html`) |
| `GET /health` | `{ status, service, redis: { ok, latencyMs, code? }, uptimeSeconds }` |
| `GET /v1/providers` | `{ providers: [{ id, name, hotels }], cities: [{ id, name }] }` |
| `GET /v1/offers` | `{ query, meta, offers }` |

`GET /v1/offers` query:

| Param | Rule |
| --- | --- |
| `city` | Required. Trimmed, 2–40 characters, `^[A-Za-z][A-Za-z .'-]*$`. Then the city alias table. |
| `checkIn`, `checkOut` | `YYYY-MM-DD`, real calendar dates. Absent or empty means tomorrow UTC, and checkout two nights after check-in. On 2026-11-21 UTC the defaults are `2026-11-22` and `2026-11-24`. Check-in cannot be before today UTC and cannot be more than 365 days out. Checkout must be after check-in. The stay cannot exceed 30 nights. |
| `guests` | Integer 1–8, default 2. |
| `minPrice`, `maxPrice` | Optional integers, rupees, `>= 0`, inclusive on the winner total. If both are set, `minPrice` must be `<= maxPrice`. |
| `sort` | `price` (default), `rating`, or `stars`. |
| `failProvider` | Optional `atlas` or `nimbus`. |

A repeated query key arrives as an array and fails validation. Unknown keys are ignored. Defaults apply when the parameter is absent.

Search headers. They are the wire contract. PowerShell `Invoke-WebRequest` reads them. `meta` repeats the same outcome for a JSON client. The route sets both from one result object.

| Header | Values |
| --- | --- |
| `X-Cache` | `HIT`, `MISS`, `BYPASS`, `COALESCED` |
| `X-Cache-Reason` | `fresh`, `stored`, `refreshed_corrupt`, `refreshed_stale`, `redis_unreachable`, `fault_injection`, `joined_inflight` |
| `X-Cache-Key` | The key above |
| `X-Cache-Age` | Whole seconds since `storedAt`, truncated, minimum 0. Present on `HIT` only. |
| `X-Offers-Before-Dedupe` | `offersBeforeDedupe` |
| `X-Offers-After-Dedupe` | `offersAfterDedupe` |
| `X-Providers-Ok` | Comma-separated ids, no spaces. `-` when none. |
| `X-Providers-Failed` | Same shape as `X-Providers-Ok`. |
| `X-Request-Id` | The client value when it matches `^[\w.-]{1,80}$`. Otherwise a new UUID. |
| `X-Response-Time-Ms` | Handler time, integer milliseconds, truncated. |
| `Cache-Control` | `no-store` |
| `Server-Timing` | `app;dur=<X-Response-Time-Ms>` |

`Cache-Control: no-store` is on search responses. Static files are `no-cache`. The Redis cache is server-side. Browsers and proxies do not store the search body.

Reason by outcome:

| `X-Cache` | `X-Cache-Reason` | When |
| --- | --- | --- |
| `HIT` | `fresh` | Valid document. Providers were not called. |
| `MISS` | `stored` | The key was written. A partial fan-out uses the same reason and a 30 second TTL. |
| `MISS` | `refreshed_corrupt` | The previous value failed schema checks and this response overwrote it. |
| `MISS` | `refreshed_stale` | The stored document was older than its own TTL. |
| `BYPASS` | `redis_unreachable` | Redis `GET` or `SET` failed. Nothing was written. A joiner of that flight is also `BYPASS`. |
| `BYPASS` | `fault_injection` | `failProvider` was set. Redis was not read or written. |
| `COALESCED` | `joined_inflight` | This request shared a leader whose result was `MISS` or `HIT`. |

Error body, for every failure:

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "Search query is invalid",
    "details": {
      "issues": [{ "path": "city", "message": "city must be at least 2 characters" }]
    },
    "requestId": "3c2a1f0e-4b5d-6a7e-8f90-1a2b3c4d5e6f"
  }
}
```

| HTTP | `code` | When | `message` | `details` |
| --- | --- | --- | --- | --- |
| 400 | `INVALID_QUERY` | Bad query | `Search query is invalid` | `{ "issues": [{ "path", "message" }] }` |
| 404 | `NOT_FOUND` | Unknown path | `No route for GET /path` | `null` |
| 502 | `PROVIDERS_UNAVAILABLE` | Both providers failed | `Every hotel provider failed` | `{ "providersFailed": [...] }` |
| 500 | `INTERNAL` | Unhandled error | `Unexpected error` | `null` |

Validation runs before the cache and the providers, so a 400 has no `X-Cache` headers. A 502 is thrown before those headers are written, so it has no `X-Cache` either. A 500 carries `X-Request-Id`. The stack stays in the log.

`meta` on a 200:

| Field | Meaning |
| --- | --- |
| `query.city` | Canonical display name (`Delhi`) |
| `query.cityId` | City slug used in the cache key |
| `query.checkIn`, `checkOut`, `nights`, `guests`, `currency`, `sort` | Resolved stay |
| `query.minPrice`, `query.maxPrice` | The bounds, or `null` |
| `meta.cache` | Same string as `X-Cache` |
| `meta.cacheReason` | Same string as `X-Cache-Reason` |
| `meta.cacheKey` | Same string as `X-Cache-Key` |
| `meta.cacheAgeSeconds` | Integer on `HIT`, otherwise `null` |
| `meta.cacheTtlSeconds` | TTL written, or the remaining TTL on a hit. `null` when nothing was stored. |
| `meta.offersBeforeDedupe`, `meta.offersAfterDedupe` | Same integers as the dedupe headers |
| `meta.returned` | `offers.length` after the filter |
| `meta.providersOk` | Provider ids that returned |
| `meta.providersFailed` | `{ provider, message }` for each failure |
| `meta.tookMs` | Same integer as `X-Response-Time-Ms` |
| `meta.requestId` | Same value as `X-Request-Id` |

A winner offer includes `alternatives` and `savingsVsNext`. Field names and the Delhi example are in `openapi.yaml`.
