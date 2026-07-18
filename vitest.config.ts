import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractsPath = fileURLToPath(
  new URL("./src/oneshot/contracts.ts", import.meta.url),
);
const contractsSource = readFileSync(contractsPath, "utf8");
const sourceVersion =
  contractsSource.match(/ONESHOT_VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";
const appVersion = process.env.ONESHOT_VERSION || sourceVersion;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
    setupFiles: ["test/setup.ts"],
  },
});
