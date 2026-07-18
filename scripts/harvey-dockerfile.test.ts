import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Harvey Dockerfile runtime", () => {
  it("pins all Node stages to Node 20 Alpine", async () => {
    const dockerfile = await readFile(
      join(process.cwd(), "Dockerfile.harvey"),
      "utf8",
    );
    const fromLines = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("FROM node:"));

    expect(fromLines).toEqual([
      "FROM node:20-alpine AS builder",
      "FROM node:20-alpine AS deps",
      "FROM node:20-alpine AS runtime",
    ]);
  });

  it("compiles TypeScript without invoking unrelated root build hooks", async () => {
    const dockerfile = await readFile(
      join(process.cwd(), "Dockerfile.harvey"),
      "utf8",
    );

    expect(dockerfile).toContain("RUN npm exec -- tsc");
    expect(dockerfile).not.toContain("RUN npm run build");
  });
});
