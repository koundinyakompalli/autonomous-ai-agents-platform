import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { runWithSpecFactoryCorrelation } from "./correlation.js";
import { specFactoryMetrics, type SpecFactoryMetrics } from "./metrics.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function specFactoryTelemetryMiddleware(
  telemetry: Pick<SpecFactoryMetrics, "recordHttpRequest"> = specFactoryMetrics,
): RequestHandler {
  return (req, res, next) => {
    const requestId = requestIdFromHeader(req.header("x-request-id"));
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);
    res.once("finish", () => {
      telemetry.recordHttpRequest({
        method: req.method,
        route: normalizedRoute(req.baseUrl, req.path),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    runWithSpecFactoryCorrelation({ requestId }, next);
  };
}

export function requestIdFromHeader(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

export function normalizedRoute(baseUrl: string, path: string): string {
  const route = `${baseUrl}${path}` || "/";
  return route
    .replace(/\/[0-9]+(?=\/|$)/g, "/:id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/:id")
    .slice(0, 160);
}
