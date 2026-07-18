// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordmarkMorph, type MorphRects } from "./WordmarkMorph.js";

const originalAnimate = HTMLElement.prototype.animate;

function mockAnimate() {
  const animateMock = vi.fn(
    () =>
      ({
        finished: Promise.resolve(),
        cancel: vi.fn(),
      }) as unknown as Animation,
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: animateMock,
  });
  return animateMock;
}

function buildRects(): MorphRects {
  return {
    from: new DOMRect(8, 12, 120, 40),
    to: new DOMRect(80, 64, 240, 96),
    fromFontSizePx: 38,
    toFontSizePx: 72,
    colors: {
      from: {
        one: "rgb(1, 2, 3)",
        shot: "rgb(4, 5, 6)",
        period: "rgb(7, 8, 9)",
      },
      to: {
        one: "rgb(10, 11, 12)",
        shot: "rgb(13, 14, 15)",
        period: "rgb(16, 17, 18)",
      },
    },
  };
}

describe("WordmarkMorph", () => {
  beforeEach(() => {
    mockAnimate();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAnimate) {
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        writable: true,
        value: originalAnimate,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });

  it.each(["light", "dark"] as const)(
    "marks the portal root with the %s theme",
    (theme) => {
      render(
        <WordmarkMorph rects={buildRects()} theme={theme} onDone={vi.fn()} />,
      );

      const portalRoot = document.body.querySelector(
        ".liquid-glass-scope[aria-hidden='true']",
      );
      expect(portalRoot?.getAttribute("data-theme")).toBe(theme);
    },
  );

  it("animates each wordmark part from source color to destination color", () => {
    const animateMock = mockAnimate();

    render(
      <WordmarkMorph rects={buildRects()} theme="light" onDone={vi.fn()} />,
    );

    const colorFrames = animateMock.mock.calls
      .map(([frames]) => frames)
      .filter(
        (frames): frames is Keyframe[] =>
          Array.isArray(frames) &&
          typeof frames[0] === "object" &&
          frames[0] !== null &&
          "color" in frames[0],
      );

    expect(colorFrames).toEqual([
      [{ color: "rgb(1, 2, 3)" }, { color: "rgb(10, 11, 12)" }],
      [{ color: "rgb(4, 5, 6)" }, { color: "rgb(13, 14, 15)" }],
      [{ color: "rgb(7, 8, 9)" }, { color: "rgb(16, 17, 18)" }],
    ]);
  });
});
