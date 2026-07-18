import { existsSync } from "node:fs";
import path from "node:path";

export interface DashboardRuntimePaths {
  appRoot: string;
  serverDir: string;
  staticDir: string;
  publicAssetsDir: string;
  defaultLayoutPath: string;
}

interface ResolveDashboardRuntimePathsOptions {
  serverDir: string;
  requireStaticDir?: boolean;
  exists?: (candidate: string) => boolean;
}

const APP_ROOT_CANDIDATES = ["..", "../..", "../../../.."] as const;

export function resolveDashboardRuntimePaths({
  serverDir,
  requireStaticDir = false,
  exists = existsSync,
}: ResolveDashboardRuntimePathsOptions): DashboardRuntimePaths {
  const checked: string[] = [];

  for (const relativeRoot of APP_ROOT_CANDIDATES) {
    const appRoot = path.resolve(serverDir, relativeRoot);
    const paths = {
      appRoot,
      serverDir,
      staticDir: path.join(appRoot, "dist/public"),
      publicAssetsDir: path.join(appRoot, "public/assets"),
      defaultLayoutPath: path.join(appRoot, "public/default-layout.json"),
    };
    const requiredPaths = [
      paths.publicAssetsDir,
      paths.defaultLayoutPath,
      ...(requireStaticDir ? [paths.staticDir] : []),
    ];
    checked.push(`${appRoot} -> ${requiredPaths.join(", ")}`);

    if (requiredPaths.every((candidate) => exists(candidate))) {
      return paths;
    }
  }

  throw new Error(
    `Unable to resolve dashboard runtime paths from ${serverDir}. Checked candidates: ${checked.join(
      " | ",
    )}`,
  );
}
