import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(level: string, env: string): Logger {
  const pretty = env !== "production" && env !== "test" && process.stdout.isTTY === true;
  return pino({
    level,
    base: { service: "hotel-offer-orchestrator" },
    redact: ["req.headers.authorization"],
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
          },
        }
      : {}),
  });
}
