import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { OfferCache } from "../cache/offer-cache.js";
import { listCities, providerStats } from "../catalog/hotels.js";
import { AppError } from "../domain/errors.js";
import { OfferOrchestrator } from "../search/orchestrator.js";
import { resolveQuery, SearchQuerySchema, type Clock } from "../search/query.js";

export type AppDeps = {
  orchestrator: OfferOrchestrator;
  cache: OfferCache;
  logger: Logger;
  clock: Clock;
};

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

function publicFile(name: string): URL {
  return new URL(`../../public/${name}`, import.meta.url);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { orchestrator, cache, logger, clock } = deps;
  const app = Fastify({
    logger: false,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (typeof incoming === "string" && /^[\w.-]{1,80}$/.test(incoming)) return incoming;
      return randomUUID();
    },
    requestIdHeader: "x-request-id",
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  app.addHook("onResponse", async (req, reply) => {
    logger.info(
      {
        requestId: req.id,
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      "request",
    );
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: req.id,
        },
      });
      return;
    }
    logger.error({ requestId: req.id, err: error }, "unhandled error");
    reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: "Unexpected error",
        details: null,
        requestId: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split("?")[0] ?? req.url;
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `No route for ${req.method} ${path}`,
        details: null,
        requestId: req.id,
      },
    });
  });

  app.get("/health", async () => {
    const redis = await cache.ping();
    return {
      status: redis.ok ? "ok" : "degraded",
      service: "hotel-offer-orchestrator",
      redis,
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  app.get("/v1/providers", async () => {
    return { providers: providerStats(), cities: listCities() };
  });

  app.get("/v1/offers", async (req, reply) => {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "INVALID_QUERY", "Search query is invalid", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const query = resolveQuery(parsed.data, clock);
    const result = await orchestrator.search(query, { requestId: req.id });
    reply.header("X-Cache", result.meta.cache);
    reply.header("X-Cache-Reason", result.meta.cacheReason);
    reply.header("X-Cache-Key", result.meta.cacheKey);
    if (result.meta.cache === "HIT" && result.meta.cacheAgeSeconds != null) {
      reply.header("X-Cache-Age", String(result.meta.cacheAgeSeconds));
    }
    reply.header("X-Offers-Before-Dedupe", String(result.meta.offersBeforeDedupe));
    reply.header("X-Offers-After-Dedupe", String(result.meta.offersAfterDedupe));
    reply.header("X-Providers-Ok", result.meta.providersOk.join(",") || "-");
    reply.header("X-Providers-Failed", result.meta.providersFailed.map((item) => item.provider).join(",") || "-");
    reply.header("X-Response-Time-Ms", String(result.meta.tookMs));
    reply.header("Server-Timing", `app;dur=${result.meta.tookMs}`);
    reply.header("Cache-Control", "no-store");
    return result;
  });

  for (const [route, spec] of Object.entries(STATIC_FILES)) {
    app.get(route, async (_req, reply) => {
      const body = await readFile(publicFile(spec.file));
      return reply.type(spec.type).header("Cache-Control", "no-cache").send(body);
    });
  }

  return app;
}
