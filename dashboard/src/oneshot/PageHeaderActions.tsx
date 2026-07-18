import { useEffect, useRef, useState } from "react";
import type { AnimationEvent, CSSProperties, MouseEvent } from "react";
import { flushSync } from "react-dom";
import { ICON_SIZE, ICON_STROKE, Moon, Search, Sun } from "./icons.js";

type Theme = "light" | "dark";
type ThemeOrbPhase = "idle" | "sunrise" | "moonrise";
type ThemeWipeOverlay = {
  key: number;
  background: string;
};

const WIPE_DURATION_MS = 700;
const THEME_ORB_PHASE_FALLBACK_MS = 720;

// Document type lacks startViewTransition in older lib.dom typings; narrow once.
type DocWithViewTransition = Document & {
  startViewTransition?: (cb: () => void) => {
    finished?: Promise<unknown>;
  };
};

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function readScopeBackground(scopeEl: HTMLElement): string {
  const styles = getComputedStyle(scopeEl);
  return (
    styles.getPropertyValue("--app-bg").trim() ||
    styles.background ||
    styles.backgroundImage ||
    styles.backgroundColor ||
    "transparent"
  );
}

export function PageHeaderActions({
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: Theme;
  onThemeChange?: (next: Theme) => void;
}) {
  const [phase, setPhase] = useState<ThemeOrbPhase>("idle");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [wipeOverlay, setWipeOverlay] = useState<ThemeWipeOverlay | null>(null);
  const phaseTimerRef = useRef<number | null>(null);
  const wipeTimerRef = useRef<number | null>(null);
  const isTransitioningRef = useRef(false);
  const mountedRef = useRef(true);
  const overlayKeyRef = useRef(0);

  const clearPhaseTimer = () => {
    if (phaseTimerRef.current !== null) {
      window.clearTimeout(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
  };

  const clearWipeTimer = () => {
    if (wipeTimerRef.current !== null) {
      window.clearTimeout(wipeTimerRef.current);
      wipeTimerRef.current = null;
    }
  };

  const clearThemeFlipState = () => {
    const rootStyle = document.documentElement.style;
    rootStyle.removeProperty("--theme-flip-x");
    rootStyle.removeProperty("--theme-flip-y");
    rootStyle.removeProperty("--theme-flip-r");
    rootStyle.removeProperty("--theme-wipe-tint");
  };

  const finishTransition = () => {
    clearWipeTimer();
    isTransitioningRef.current = false;
    document.documentElement.removeAttribute("data-oneshot-theme-transition");
    clearThemeFlipState();
    if (mountedRef.current) {
      setIsTransitioning(false);
      setWipeOverlay(null);
    }
  };

  const finishPhase = () => {
    clearPhaseTimer();
    if (mountedRef.current) {
      setPhase("idle");
    }
  };

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        clearPhaseTimer();
        clearWipeTimer();
        document.documentElement.removeAttribute("data-oneshot-theme-transition");
        clearThemeFlipState();
      };
    },
    [],
  );

  const handleThemeOrbClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (!theme || !onThemeChange || isTransitioningRef.current) return;
    const next: Theme = theme === "dark" ? "light" : "dark";
    const reduceMotion = prefersReducedMotion();

    // Capture the orb's screen position so the wipe radiates from here.
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxR = Math.hypot(
      Math.max(cx, window.innerWidth - cx),
      Math.max(cy, window.innerHeight - cy),
    );
    const root = document.documentElement;
    root.style.setProperty("--theme-flip-x", `${cx}px`);
    root.style.setProperty("--theme-flip-y", `${cy}px`);
    root.style.setProperty("--theme-flip-r", `${maxR}px`);
    root.style.setProperty(
      "--theme-wipe-tint",
      next === "light"
        ? "rgba(237, 169, 89, 0.24)"
        : "rgba(112, 134, 220, 0.22)",
    );

    if (reduceMotion) {
      onThemeChange(next);
      clearThemeFlipState();
      return;
    }

    isTransitioningRef.current = true;
    setIsTransitioning(true);
    setPhase(next === "light" ? "sunrise" : "moonrise");
    clearPhaseTimer();
    phaseTimerRef.current = window.setTimeout(() => {
      finishPhase();
    }, THEME_ORB_PHASE_FALLBACK_MS);

    const doc = document as DocWithViewTransition;

    if (typeof doc.startViewTransition === "function") {
      // Primary: View Transitions API. flushSync ensures React commits the
      // theme change synchronously inside the callback so the post-update
      // snapshot reflects the new theme.
      root.setAttribute("data-oneshot-theme-transition", "true");
      const transition = doc.startViewTransition(() => {
        flushSync(() => onThemeChange(next));
      });
      clearWipeTimer();
      wipeTimerRef.current = window.setTimeout(
        finishTransition,
        WIPE_DURATION_MS + 120,
      );
      void transition.finished?.then(finishTransition, finishTransition);
      return;
    }

    // Firefox / older browsers: React-rendered radial overlay fallback.
    const scopeEl = document.querySelector<HTMLElement>("[data-oneshot-scope]");
    if (scopeEl) {
      setWipeOverlay({
        key: (overlayKeyRef.current += 1),
        background: readScopeBackground(scopeEl),
      });
      onThemeChange(next);
      clearWipeTimer();
      wipeTimerRef.current = window.setTimeout(
        finishTransition,
        WIPE_DURATION_MS + 20,
      );
      return;
    }

    onThemeChange(next);
    finishTransition();
  };

  const handleAnimationEnd = (e: AnimationEvent<HTMLButtonElement>) => {
    if (
      e.animationName === "sun-rays-bloom" ||
      e.animationName === "moonrise-moon"
    ) {
      finishPhase();
    }
  };

  return (
    <div className="page-actions">
      {theme && onThemeChange ? (
        <button
          type="button"
          className={`btn-theme-orb${phase === "sunrise" ? " is-sunrise" : ""}${
            phase === "moonrise" ? " is-moonrise" : ""
          }`}
          role="switch"
          aria-checked={theme === "light"}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          data-state={theme}
          data-phase={phase}
          disabled={isTransitioning}
          onClick={handleThemeOrbClick}
          onAnimationEnd={handleAnimationEnd}
        >
          <span className="theme-orb-glow" aria-hidden="true" />
          <span className="theme-orb-rays" aria-hidden="true" />
          <span className="theme-orb-disc" aria-hidden="true">
            <Sun
              className="theme-orb-icon theme-orb-icon-sun"
              data-active={theme === "light" ? "true" : "false"}
              size={ICON_SIZE.sm}
              strokeWidth={ICON_STROKE}
              aria-hidden="true"
            />
            <Moon
              className="theme-orb-icon theme-orb-icon-moon"
              data-active={theme === "dark" ? "true" : "false"}
              size={ICON_SIZE.sm}
              strokeWidth={ICON_STROKE}
              aria-hidden="true"
            />
          </span>
        </button>
      ) : null}
      {wipeOverlay ? (
        <span
          key={wipeOverlay.key}
          className="theme-wipe-overlay"
          style={
            {
              "--theme-wipe-overlay-bg": wipeOverlay.background,
            } as CSSProperties
          }
          aria-hidden="true"
        />
      ) : null}
      <button
        type="button"
        className="btn-search-circle"
        onClick={onSearch}
        aria-label="Search (⌘K)"
        title="Search (⌘K)"
      >
        <Search
          size={ICON_SIZE.sm}
          strokeWidth={ICON_STROKE}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className="btn-primary"
        onClick={onNewRun}
        disabled={!onNewRun}
      >
        <span>+</span>
        <span>new run</span>
      </button>
    </div>
  );
}
