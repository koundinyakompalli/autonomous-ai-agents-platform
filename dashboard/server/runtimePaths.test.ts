import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDashboardRuntimePaths } from "./runtimePaths.js";

const tempRoots: string[] = [];

function makeDashboardRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-runtime-paths-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "dist/public"), { recursive: true });
  mkdirSync(path.join(root, "public/assets"), { recursive: true });
  writeFileSync(path.join(root, "dist/public/index.html"), "<!doctype html>");
  writeFileSync(path.join(root, "public/default-layout.json"), "{}");
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveDashboardRuntimePaths", () => {
  it("resolves assets from the flat dist/server layout", () => {
    const root = makeDashboardRoot();
    const serverDir = path.join(root, "dist/server");
    mkdirSync(serverDir, { recursive: true });

    expect(resolveDashboardRuntimePaths({ serverDir, requireStaticDir: true })).toEqual({
      appRoot: root,
      serverDir,
      staticDir: path.join(root, "dist/public"),
      publicAssetsDir: path.join(root, "public/assets"),
      defaultLayoutPath: path.join(root, "public/default-layout.json"),
    });
  });

  it("resolves assets from the nested dist/server/dashboard/server layout", () => {
    const root = makeDashboardRoot();
    const serverDir = path.join(root, "dist/server/dashboard/server");
    mkdirSync(serverDir, { recursive: true });

    expect(resolveDashboardRuntimePaths({ serverDir, requireStaticDir: true })).toEqual({
      appRoot: root,
      serverDir,
      staticDir: path.join(root, "dist/public"),
      publicAssetsDir: path.join(root, "public/assets"),
      defaultLayoutPath: path.join(root, "public/default-layout.json"),
    });
  });

  it("throws with checked candidates when dashboard assets cannot be resolved", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dashboard-runtime-paths-missing-"));
    tempRoots.push(root);
    const serverDir = path.join(root, "dist/server/dashboard/server");
    mkdirSync(serverDir, { recursive: true });

    expect(() => resolveDashboardRuntimePaths({ serverDir, requireStaticDir: true })).toThrow(
      /Unable to resolve dashboard runtime paths.*dist\/server\/dashboard\/server.*dist\/server/s,
    );
  });
});
