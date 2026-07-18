// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageHeaderActions } from "./PageHeaderActions.js";

type StartViewTransition = NonNullable<
  Document & {
    startViewTransition?: (cb: () => void) => { finished?: Promise<unknown> };
  }["startViewTransition"]
>;

let originalMatchMedia: PropertyDescriptor | undefined;
let originalStartViewTransition: PropertyDescriptor | undefined;

function stubReducedMotion(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({
      matches,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

function stubStartViewTransition(fn: StartViewTransition): void {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    writable: true,
    value: fn,
  });
}

function removeStartViewTransition(): void {
  Reflect.deleteProperty(document, "startViewTransition");
}

function restoreDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    Reflect.deleteProperty(target, property);
  }
}

function renderActions(
  props: Partial<Parameters<typeof PageHeaderActions>[0]> = {},
) {
  const onThemeChange = vi.fn();
  render(
    <PageHeaderActions
      onSearch={vi.fn()}
      onNewRun={vi.fn()}
      theme="dark"
      onThemeChange={onThemeChange}
      {...props}
    />,
  );
  return { onThemeChange };
}

function renderActionsInScope(
  props: Partial<Parameters<typeof PageHeaderActions>[0]> = {},
) {
  const onThemeChange = vi.fn();
  render(
    <div
      data-oneshot-scope="true"
      style={
        {
          "--app-bg": "linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))",
        } as CSSProperties
      }
    >
      <PageHeaderActions
        onSearch={vi.fn()}
        onNewRun={vi.fn()}
        theme="dark"
        onThemeChange={onThemeChange}
        {...props}
      />
    </div>,
  );
  return { onThemeChange };
}

describe("PageHeaderActions theme orb", () => {
  beforeEach(() => {
    originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    originalStartViewTransition = Object.getOwnPropertyDescriptor(
      document,
      "startViewTransition",
    );
    document.documentElement.removeAttribute("data-oneshot-theme-transition");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreDescriptor(window, "matchMedia", originalMatchMedia);
    restoreDescriptor(
      document,
      "startViewTransition",
      originalStartViewTransition,
    );
    document.documentElement.removeAttribute("data-oneshot-theme-transition");
    document.documentElement.style.removeProperty("--theme-flip-x");
    document.documentElement.style.removeProperty("--theme-flip-y");
    document.documentElement.style.removeProperty("--theme-flip-r");
    document.documentElement.style.removeProperty("--theme-wipe-tint");
  });

  it("uses the scoped View Transitions path when supported", async () => {
    stubReducedMotion(false);
    let finishTransition!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished };
    });
    stubStartViewTransition(startViewTransition);
    const { onThemeChange } = renderActions();

    fireEvent.click(screen.getByRole("switch", { name: /switch to light/i }));

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(onThemeChange).toHaveBeenCalledWith("light");
    expect(
      document.documentElement.getAttribute("data-oneshot-theme-transition"),
    ).toBe("true");

    await act(async () => {
      finishTransition();
      await finished;
    });

    expect(
      document.documentElement.hasAttribute("data-oneshot-theme-transition"),
    ).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue("--theme-wipe-tint"),
    ).toBe("");
  });

  it("marks the sun and moon icons active for the current theme", () => {
    const onThemeChange = vi.fn();
    const { rerender } = render(
      <PageHeaderActions
        onSearch={vi.fn()}
        onNewRun={vi.fn()}
        theme="dark"
        onThemeChange={onThemeChange}
      />,
    );

    expect(
      document
        .querySelector(".theme-orb-icon-moon")
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      document
        .querySelector(".theme-orb-icon-sun")
        ?.getAttribute("data-active"),
    ).toBe("false");

    rerender(
      <PageHeaderActions
        onSearch={vi.fn()}
        onNewRun={vi.fn()}
        theme="light"
        onThemeChange={onThemeChange}
      />,
    );

    expect(
      document
        .querySelector(".theme-orb-icon-sun")
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      document
        .querySelector(".theme-orb-icon-moon")
        ?.getAttribute("data-active"),
    ).toBe("false");
  });

  it("cleans up View Transition state after StrictMode remount checks", async () => {
    stubReducedMotion(false);
    let finishTransition!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    stubStartViewTransition(
      vi.fn((cb: () => void) => {
        cb();
        return { finished };
      }),
    );
    const onThemeChange = vi.fn();
    render(
      <StrictMode>
        <PageHeaderActions
          onSearch={vi.fn()}
          onNewRun={vi.fn()}
          theme="dark"
          onThemeChange={onThemeChange}
        />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("switch", { name: /switch to light/i }));

    await act(async () => {
      finishTransition();
      await finished;
    });

    const toggle = screen.getByRole("switch");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders and clears a dedicated fallback wipe overlay", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    removeStartViewTransition();
    const { onThemeChange } = renderActionsInScope();

    fireEvent.click(screen.getByRole("switch", { name: /switch to light/i }));

    expect(onThemeChange).toHaveBeenCalledWith("light");
    const overlay = document.querySelector<HTMLElement>(".theme-wipe-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay?.style.getPropertyValue("--theme-wipe-overlay-bg")).toContain(
      "linear-gradient",
    );

    act(() => {
      vi.advanceTimersByTime(720);
    });

    expect(document.querySelector(".theme-wipe-overlay")).toBeNull();
  });

  it("snaps instantly for reduced motion", () => {
    stubReducedMotion(true);
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    stubStartViewTransition(startViewTransition);
    const { onThemeChange } = renderActionsInScope();

    fireEvent.click(screen.getByRole("switch", { name: /switch to light/i }));

    expect(onThemeChange).toHaveBeenCalledWith("light");
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(document.querySelector(".theme-wipe-overlay")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--theme-flip-x")).toBe(
      "",
    );
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("cleans fallback timers and overlay state on unmount", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    removeStartViewTransition();
    const { unmount } = render(
      <div
        data-oneshot-scope="true"
        style={{ "--app-bg": "rgb(1, 2, 3)" } as CSSProperties}
      >
        <PageHeaderActions
          onSearch={vi.fn()}
          onNewRun={vi.fn()}
          theme="dark"
          onThemeChange={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(screen.getByRole("switch", { name: /switch to light/i }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(
      document.documentElement.hasAttribute("data-oneshot-theme-transition"),
    ).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue("--theme-wipe-tint"),
    ).toBe("");
  });

  it("ignores repeated clicks while the theme transition is active", async () => {
    stubReducedMotion(false);
    let finishTransition!: () => void;
    const finished = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { finished };
    });
    stubStartViewTransition(startViewTransition);
    const { onThemeChange } = renderActions();
    const toggle = screen.getByRole("switch", { name: /switch to light/i });

    act(() => {
      fireEvent.click(toggle);
      fireEvent.click(toggle);
    });

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(onThemeChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishTransition();
      await finished;
    });
  });
});
