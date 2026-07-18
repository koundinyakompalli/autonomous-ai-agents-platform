import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

describe("oneshot claude sdk dependency isolation", () => {
  it("keeps the root SDK and the OneShot alias pinned independently", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, { version?: string } | undefined>;
    };
    const packages = lock.packages;

    expect(
      packages["node_modules/@anthropic-ai/claude-agent-sdk"]?.version,
    ).toBe("0.3.187");
    expect(
      packages["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"]
        ?.version,
    ).toBe("0.3.187");
    expect(
      packages["node_modules/@specter/oneshot-claude-agent-sdk"]?.version,
    ).toBe("0.3.183");
    expect(
      packages[
        "node_modules/@specter/oneshot-claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"
      ]?.version,
    ).toBe("0.3.183");
  });
});
