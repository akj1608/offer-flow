import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4781),
  HOST: z.string().min(1).default("0.0.0.0"),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(20).max(10_000).default(800),
  MOCK_LATENCY_MS: z.coerce.number().int().min(0).max(5_000).default(120),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Config = {
  port: number;
  host: string;
  redisUrl: string;
  cacheTtlSeconds: number;
  providerTimeoutMs: number;
  mockLatencyMs: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  nodeEnv: string;
};

/** Fill keys the process does not already have, so a shell export wins over .env. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options?: { dotenv?: boolean }): Config {
  if (options?.dotenv !== false) loadDotEnv();
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment: ${message}`);
  }
  return {
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    redisUrl: parsed.data.REDIS_URL,
    cacheTtlSeconds: parsed.data.CACHE_TTL_SECONDS,
    providerTimeoutMs: parsed.data.PROVIDER_TIMEOUT_MS,
    mockLatencyMs: parsed.data.MOCK_LATENCY_MS,
    logLevel: parsed.data.LOG_LEVEL,
    nodeEnv: parsed.data.NODE_ENV,
  };
}
