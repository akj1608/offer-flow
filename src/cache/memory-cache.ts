import { CacheUnavailableError } from "../domain/errors.js";
import type { CachePing, OfferCache } from "./offer-cache.js";

export class MemoryOfferCache implements OfferCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async ping(): Promise<CachePing> {
    return { ok: true, latencyMs: 0 };
  }

  async quit(): Promise<void> {
    return undefined;
  }
}

/** Behaves like a refused Redis port. Used to prove search still returns offers. */
export class DownOfferCache implements OfferCache {
  private fail(): never {
    throw new CacheUnavailableError("connect ECONNREFUSED 127.0.0.1:6379", {
      code: "ECONNREFUSED",
      host: "127.0.0.1",
      port: 6379,
    });
  }

  async get(_key: string): Promise<string | null> {
    this.fail();
  }

  async set(_key: string, _value: string, _ttlSeconds: number): Promise<void> {
    this.fail();
  }

  async delete(_key: string): Promise<void> {
    this.fail();
  }

  async ping(): Promise<CachePing> {
    return {
      ok: false,
      latencyMs: 0,
      error: "connect ECONNREFUSED 127.0.0.1:6379",
      code: "ECONNREFUSED",
    };
  }

  async quit(): Promise<void> {
    return undefined;
  }
}
