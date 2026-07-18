import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverDir = path.dirname(fileURLToPath(import.meta.url));

function readProductionFallbackRoute(): string {
  const source = readFileSync(path.join(serverDir, "index.ts"), "utf8");
  const match = source.match(
    /const indexHtml = readFileSync\(path\.join\(staticDir,\s*["'`]index\.html["'`]\),\s*["'`]utf8["'`]\)\s*app\.use\(express\.static\(staticDir\)\)\s*app\.get\((["'`])([^"'`]+)\1,/s,
  );

  if (!match) {
    throw new Error("Production fallback route was not found in server/index.ts");
  }

  return match[2];
}

describe("production fallback route", () => {
  it("uses an Express 5-compatible wildcard route", () => {
    const app = express();

    expect(() => {
      app.get(readProductionFallbackRoute(), (_req, res) => {
        res.end();
      });
    }).not.toThrow();
  });

  it("does not read index.html from disk for every fallback request", () => {
    const source = readFileSync(path.join(serverDir, "index.ts"), "utf8");

    expect(source).toContain("const indexHtml = readFileSync(path.join(staticDir, 'index.html'), 'utf8')");
    expect(source).toContain("res.type('html').send(indexHtml)");
  });
});
