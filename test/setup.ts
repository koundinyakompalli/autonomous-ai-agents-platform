import { createRequire } from "node:module";
import path from "node:path";
import { afterEach } from "vitest";

const requireDashboard = createRequire(
  path.join(process.cwd(), "dashboard", "package.json"),
);

afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = requireDashboard("@testing-library/react") as {
    cleanup: () => void;
  };
  cleanup();
});
