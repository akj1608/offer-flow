# Offer Desk operations

The process listens on port 4781. Redis defaults to `redis://127.0.0.1:6379`. Search answers while Redis is down. `X-Cache: BYPASS` and a warning line are the outage signal.

## Local run

From the repo root, with Node 20 or newer:

```bash
npm install
npm test
npm run dev
```

`npm test` runs the unit suite. The suite constructs the in-memory cache port and does not need a Redis process. `npm run dev` starts Fastify with the defaults below. The desk is at `http://127.0.0.1:4781/` and the search endpoint is `http://127.0.0.1:4781/v1/offers`.

Stop Redis before a bypass demo, or point `REDIS_URL` at a closed port. Start Redis on `127.0.0.1:6379` before expecting `HIT`.

## Docker Compose

From the repo root:

```bash
docker compose up --build
```

Compose publishes the app on port 4781 and Redis on port 6379. The app container uses `REDIS_URL=redis://redis:6379`. From the host, curl `http://127.0.0.1:4781` and test Redis on `127.0.0.1:6379`.

The host in the warning is the host the process dialed. On the default local URL that is `127.0.0.1`. Inside Compose it is `redis`. A published-port check from the host can succeed while the app logs `host=redis` and `code=ENOTFOUND` when the app container is not on the Compose network.

`docker compose down` sends `SIGTERM`. The process closes Fastify, closes the Redis client, and exits.

Running the Node process on the host against Compose Redis needs the published port and the default `REDIS_URL`.

## See a miss, then a hit

Use explicit dates so the key does not move at UTC midnight. Send the second request after the first response has arrived. Two overlapping requests share one fan-out: one returns `MISS` (or `BYPASS`) and the other returns `COALESCED`. That is singleflight. It is not a failed hit.

Pick a key and delete it so the first request cannot be a hit left over from an earlier run:

```bash
KEY='offers:v1:delhi:2026-11-22:2026-11-24:2:inr'
redis-cli -u redis://127.0.0.1:6379 DEL "$KEY"

curl -sD - -o /tmp/offers.json \
  'http://127.0.0.1:4781/v1/offers?city=delhi&checkIn=2026-11-22&checkOut=2026-11-24&guests=2'
```

The first response carries:

```
HTTP/1.1 200 OK
X-Cache: MISS
X-Cache-Reason: stored
X-Cache-Key: offers:v1:delhi:2026-11-22:2026-11-24:2:inr
X-Providers-Ok: atlas,nimbus
X-Providers-Failed:
Cache-Control: no-store
Server-Timing: app;dur=18
```

`X-Cache-Reason` stays `stored` when one provider failed. The key then lives for 30 seconds. `X-Offers-Before-Dedupe` and `X-Offers-After-Dedupe` are the merge counts for whatever the catalog returned. `X-Request-Id` and `X-Response-Time-Ms` are always present. `X-Cache-Age` is absent on a miss.

Confirm the write, then repeat the same URL:

```bash
redis-cli -u redis://127.0.0.1:6379 GET "$KEY"

curl -sD - -o /dev/null \
  'http://127.0.0.1:4781/v1/offers?city=delhi&checkIn=2026-11-22&checkOut=2026-11-24&guests=2'
```

The second response carries `X-Cache: HIT`, `X-Cache-Reason: fresh`, and `X-Cache-Age` as a non-negative integer. The key header is unchanged. The body lists the same hotels, filtered and sorted for this request. Provider latency does not add to the second response.

`GET` prints the stored JSON: `version`, `storedAt`, `ttlSeconds`, provider outcomes, dedupe counts, and the merged hotels. The value is the merge, not the raw provider payloads.

A request that uses only the default dates is the same check. On 2026-11-21 UTC the default key is the key above. The next UTC day changes the dates inside the key.

```bash
curl -sD - -o /dev/null 'http://127.0.0.1:4781/v1/offers?city=delhi'
```

`meta.cache` in `/tmp/offers.json` repeats `X-Cache`, the reason, the key, and the age. Headers remain the wire contract.

## PowerShell

`Invoke-WebRequest` keeps the headers. `Invoke-RestMethod` parses JSON and drops them, so it cannot show `X-Cache`.

```powershell
$r = Invoke-WebRequest "http://localhost:4781/v1/offers?city=delhi"
$r.Headers["X-Cache"]
Test-NetConnection -ComputerName 127.0.0.1 -Port 6379
```

The first call of a given default-date key returns `MISS` when Redis is up and the key was absent. The next call, after the first has returned, returns `HIT`. `TcpTestSucceeded` is `True` when port 6379 accepts a connection. The service emits the header name as `X-Cache`. PowerShell 7 looks that name up without case sensitivity.

The JSON body is `$r.Content`. `meta.cache` matches `$r.Headers["X-Cache"]`.

## Linux port check

```bash
nc -z 127.0.0.1 6379
echo $?
ss -ltn 'sport = :6379'
```

`nc -z` exits 0 when the port accepts TCP and non-zero when it does not. It prints nothing on success. `ss` lists a listening socket when Redis is bound to 6379. `ECONNREFUSED` in the app log means this check fails for the host and port in that log.

## When caching is skipped

Grep for this message:

```
cache bypassed because redis is unreachable
```

Canonical line when `NODE_ENV=production` (pino level 40 is warn). `time`, `pid`, and `hostname` may also be present. The contract fields are `msg`, `host`, `port`, and `code`:

```json
{"level":40,"msg":"cache bypassed because redis is unreachable","host":"127.0.0.1","port":6379,"code":"ECONNREFUSED"}
```

In development the same event is a pretty warn line with the same message and the same three fields: `host=127.0.0.1 port=6379 code=ECONNREFUSED`.

Meaning: this request did not use a cached document and did not write one. The offers in the response came from the provider fan-out. `host` and `port` are parsed from `REDIS_URL`. `code` is the syscall error. `ECONNREFUSED` means nothing accepted the TCP connection. `ENOTFOUND` means the host name did not resolve. `ETIMEDOUT` means the 300ms budget expired. The next step is to test the logged port and start Redis there. Restarting the API does not open the port.

The line is emitted once per failed `GET` or `SET` on a user request. Health scrapes do not emit it. A `failProvider` request skips Redis without this warning. Its header reason is `fault_injection`.

A corrupt value logs a different warning, `cache payload corrupt; refreshing`, with the field `key`. That request overwrites the key and returns `MISS` / `refreshed_corrupt`.

## Redis pill

The desk at `GET /` shows a pill driven by `GET /health`, which the page requests on load and again when a search returns `redis_unreachable`.

| Pill | Health body | Meaning |
| --- | --- | --- |
| `redis up` | `status: ok`, `redis: up` | Redis answered the ping. A search may be `HIT`, `MISS`, or `COALESCED`. |
| `redis down` | `status: degraded`, `redis: down` | Redis did not answer. Search still returns offers. The cache chip reads `BYPASS`. |

The pill is the Redis signal. It is not a cache-hit indicator, and it is not a gate. The process stays ready while the pill is down. The cache chip next to the results is `meta.cache`, which matches `X-Cache`: `HIT`, `MISS`, `BYPASS`, or `COALESCED`.

`BYPASS` with reason `fault_injection` means this search skipped the cache on purpose. The pill can still read `redis up`.

## Environment

Boot fails, and the process does not listen, when a variable is set and fails its check. Unset variables take the default.

| Variable | Default | Check |
| --- | --- | --- |
| `PORT` | `4781` | Integer 1–65535 |
| `HOST` | `0.0.0.0` | Bind address |
| `REDIS_URL` | `redis://127.0.0.1:6379` | A `redis://` URL. Userinfo is never logged. |
| `CACHE_TTL_SECONDS` | `900` | Positive integer. Full results add jitter of 0–30 seconds. Partial results stay at 30 seconds and ignore this variable. |
| `PROVIDER_TIMEOUT_MS` | `800` | Positive integer. Per provider. |
| `MOCK_LATENCY_MS` | `120` | Integer `>= 0`. Set it above `PROVIDER_TIMEOUT_MS` to time a provider out. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `NODE_ENV` | `development` | `development`, `test`, `production`. Production logs JSON. |

The Redis connect and command timeouts (300ms), the disabled offline queue, the partial TTL (30 seconds), and the jitter span (0 through 30 inclusive) are constants. They are not environment variables.

`PROVIDER_TIMEOUT_MS=200` and `MOCK_LATENCY_MS=500` makes both mocks time out: HTTP 502, `PROVIDERS_UNAVAILABLE`, and no Redis write. `failProvider=atlas` on one request fails Atlas without that env change and without a write.

## Failure modes

| Situation | HTTP | `X-Cache` | Reason | Redis write | What you see |
| --- | --- | --- | --- | --- | --- |
| Redis down | 200 | `BYPASS` | `redis_unreachable` | no | Warn log with host, port, and code. Pill reads `redis down`. Offers come from the fan-out. |
| One provider down | 200 | `MISS`, then `HIT` for 30s | `stored`, then `fresh` | yes, 30s | The failed id is in `X-Providers-Failed`. A hit inside the window does not retry it. |
| Both providers down | 502 | absent | absent | no | Body `error.code` is `PROVIDERS_UNAVAILABLE`. `details.providersFailed` lists both ids. |
| Both providers down, Redis down | 502 | absent | absent | no | The bypass warning is logged, then the handler throws. No `X-Cache` header. |
| Corrupt payload | 200 | `MISS` | `refreshed_corrupt` | overwrite | Warn `cache payload corrupt; refreshing`. The next request is `HIT`. |
| `failProvider` set, the other provider returns | 200 | `BYPASS` | `fault_injection` | no | No Redis warning. The named id is in `X-Providers-Failed`. |
| Bad query | 400 | absent | absent | no | `INVALID_QUERY`. `details.errors` names the field. |
| Unknown path | 404 | absent | absent | no | `NOT_FOUND`, message `No route for GET /path`. |
| Unhandled error | 500 | absent | absent | no | `INTERNAL`, message `Unexpected error`. The stack is in the log. |

An empty catalog result for a valid city is a normal 200. Both providers returned, so the empty merge is cached for the full TTL. That outcome is not `PROVIDERS_UNAVAILABLE`.

## `npm run verify:cache`

`npm run verify:cache` checks `MISS` then `HIT` against a server that is already running. It is not part of `npm test`.

1. Delete `offers:v1:delhi:2026-12-02:2026-12-05:2:inr`. It does not flush the database. If Redis cannot be reached, the script exits 2.
2. `GET` that stay on `BASE_URL` (default `http://127.0.0.1:4781`). Expect HTTP 200 and `X-Cache: MISS`.
3. `GET` the same URL again. Expect HTTP 200 and `X-Cache: HIT`.
4. Expect Nimbus to win `delhi:the-oberoi`, and expect the Redis value to contain that id.
5. Exit 0 only when all of that holds. A header or winner mismatch exits 1. A server that is not listening exits 2.

The two requests are sequential. A parallel pair would observe `COALESCED` on the waiter and fail the `HIT` assertion.
