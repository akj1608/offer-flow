export type CachePing = {
  ok: boolean;
  latencyMs: number;
  error?: string;
  code?: string;
};

/**
 * String store with a TTL. The orchestrator owns the JSON shape.
 * Redis and the in-memory test double both implement this.
 */
export interface OfferCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  ping(): Promise<CachePing>;
  quit(): Promise<void>;
}
