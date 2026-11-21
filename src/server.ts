import { RedisOfferCache, redisEndpoint } from "./cache/redis-cache.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildApp } from "./http/app.js";
import { MockHotelProvider } from "./providers/mock-provider.js";
import { OfferOrchestrator } from "./search/orchestrator.js";
import { systemClock } from "./search/query.js";

const config = loadConfig();
const logger = createLogger(config.logLevel, config.nodeEnv);
const cache = new RedisOfferCache(config.redisUrl, logger);
const providers = [
  new MockHotelProvider("atlas", config.mockLatencyMs),
  new MockHotelProvider("nimbus", config.mockLatencyMs),
];
const orchestrator = new OfferOrchestrator(providers, cache, {
  ttlSeconds: config.cacheTtlSeconds,
  providerTimeoutMs: config.providerTimeoutMs,
  logger,
});
const app = buildApp({ orchestrator, cache, logger, clock: systemClock });

const endpoint = redisEndpoint(config.redisUrl);
const startup = await cache.ping();
if (startup.ok) {
  logger.info({ host: endpoint.host, port: endpoint.port, latencyMs: startup.latencyMs }, "redis ping ok");
} else {
  logger.warn(
    { host: endpoint.host, port: endpoint.port, code: startup.code, err: startup.error },
    "redis ping failed at startup; searches will bypass the cache until redis is reachable",
  );
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  await app.close();
  await cache.quit();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await app.listen({ port: config.port, host: config.host });
logger.info({ port: config.port, host: config.host }, "listening");
