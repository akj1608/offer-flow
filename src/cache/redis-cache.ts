import { Redis } from "ioredis";
import type { Logger } from "pino";
import { CacheUnavailableError, errorCode, errorMessage } from "../domain/errors.js";
import type { CachePing, OfferCache } from "./offer-cache.js";

export function redisEndpoint(url: string): { host: string; port: number } {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : 6379;
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number.isFinite(port) ? port : 6379,
    };
  } catch {
    return { host: "unknown", port: 6379 };
  }
}

/**
 * Fail fast when Redis is down. Commands are not queued, and each attempt
 * is capped by connectTimeout / commandTimeout. A dead socket is replaced
 * once so a Redis that starts later is picked up without a process restart.
 */
export class RedisOfferCache implements OfferCache {
  private redis: Redis;
  private readonly endpoint: { host: string; port: number };
  private lastErrorLog = 0;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
  ) {
    this.endpoint = redisEndpoint(url);
    this.redis = this.createClient();
  }

  private createClient(): Redis {
    const client = new Redis(this.url, {
      connectTimeout: 300,
      commandTimeout: 300,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy(times: number) {
        return Math.min(200 * times, 2000);
      },
    });
    client.on("error", (error: Error & { code?: string }) => {
      const now = Date.now();
      if (now - this.lastErrorLog < 5_000) return;
      this.lastErrorLog = now;
      this.logger.warn(
        {
          host: this.endpoint.host,
          port: this.endpoint.port,
          code: error.code ?? "REDIS_UNAVAILABLE",
          err: error.message,
        },
        "redis client error",
      );
    });
    return client;
  }

  private unavailable(error: unknown): CacheUnavailableError {
    return new CacheUnavailableError(errorMessage(error), {
      cause: error,
      code: errorCode(error),
      host: this.endpoint.host,
      port: this.endpoint.port,
    });
  }

  private async ensureConnected(client: Redis): Promise<void> {
    const status = client.status;
    if (status === "ready") return;
    if (status === "end") {
      throw Object.assign(new Error("redis connection closed"), { code: "NR_CLOSED" });
    }
    try {
      await client.connect();
    } catch (error) {
      if (String(client.status) === "ready") return;
      throw error;
    }
  }

  private async command<T>(run: (client: Redis) => Promise<T>): Promise<T> {
    try {
      await this.ensureConnected(this.redis);
      return await run(this.redis);
    } catch (error) {
      try {
        this.redis.disconnect();
      } catch {
        // The socket is already gone.
      }
      this.redis = this.createClient();
      try {
        await this.ensureConnected(this.redis);
        return await run(this.redis);
      } catch (retryError) {
        throw this.unavailable(retryError);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    return this.command((client) => client.get(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.command((client) => client.set(key, value, "EX", ttlSeconds));
  }

  async delete(key: string): Promise<void> {
    await this.command(async (client) => {
      await client.del(key);
    });
  }

  async ping(): Promise<CachePing> {
    const started = Date.now();
    try {
      const reply = await this.command((client) => client.ping());
      return { ok: reply === "PONG", latencyMs: Date.now() - started };
    } catch (error) {
      const unavailable = error instanceof CacheUnavailableError ? error : this.unavailable(error);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: unavailable.message,
        code: unavailable.code,
      };
    }
  }

  async quit(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
