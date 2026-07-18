// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidebarMorph,
  type SidebarMorphSnapshot,
} from "./SidebarMorph.js";

const originalAnimate = HTMLElement.prototype.animate;

function mockAnimate() {
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: vi.fn(
      () =>
        ({
          finished: Promise.resolve(),
          cancel: vi.fn(),
        }) as unknown as Animation,
    ),
  });
}

function buildSnapshot(): SidebarMorphSnapshot {
  return {
    direction: "enter",
    from: new DOMRect(16, 16, 240, 640),
    to: new DOMRect(-420, 16, 240, 640),
    html: `
      <div class="brand">
        <h1 class="oneshot-wordmark">
          <span class="wm-one">One</span><span class="wm-shot">Shot</span><span class="wm-period">.</span>
        </h1>
        <button type="button">Guide</button>
      </div>
    `,
  };
}

describe("SidebarMorph", () => {
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
      render(<SidebarMorph snapshot={buildSnapshot()} theme={theme} />);

      const portalRoot = document.body.querySelector(".sidebar-morph-layer");
      expect(portalRoot?.getAttribute("data-theme")).toBe(theme);
    },
  );

  it("removes cloned sidebar controls from the tab order", () => {
    render(<SidebarMorph snapshot={buildSnapshot()} theme="light" />);

    const clonedButton = document.body.querySelector(
      ".sidebar-morph-shell button",
    );
    expect(clonedButton?.getAttribute("tabindex")).toBe("-1");
  });
});
