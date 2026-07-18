import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const contractsPath = fileURLToPath(
  new URL("../src/oneshot/contracts.ts", import.meta.url),
);
const contractsSource = readFileSync(contractsPath, "utf8");
const sourceVersion =
  contractsSource.match(/ONESHOT_VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";
const appVersion = process.env.ONESHOT_VERSION || sourceVersion;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    // Keep the default environment lightweight; DOM tests can opt into jsdom
    // explicitly when they are added.
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.{ts,tsx}"],
    css: false,
  },
});
