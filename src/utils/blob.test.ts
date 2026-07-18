import { describe, expect, it } from "vitest";
import { bufferToBlobPart } from "./blob.js";

describe("bufferToBlobPart", () => {
  it("copies the visible bytes from a Buffer", async () => {
    const source = Buffer.from("prefix-visible-suffix");
    const slice = source.subarray("prefix-".length, "prefix-visible".length);
    const blob = new Blob([bufferToBlobPart(slice)]);

    await expect(blob.text()).resolves.toBe("visible");
  });
});
