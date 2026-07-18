import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Symmetric ease-in-out so translate and size advance together.
const EASE = "cubic-bezier(0.45, 0, 0.35, 1)";
const DURATION_MS = 820;
const WORDMARK_PARTS = [
  ["one", ".wm-one"],
  ["shot", ".wm-shot"],
  ["period", ".wm-period"],
] as const;

type Theme = "light" | "dark";

export type WordmarkMorphColors = Record<
  (typeof WORDMARK_PARTS)[number][0],
  string
>;

export type MorphRects = {
  from: DOMRect;
  to: DOMRect;
  /** Computed font-size of the source element in px, so the clone starts as
   *  the actual sidebar/About wordmark rather than a scaled approximation. */
  fromFontSizePx: number;
  /** Computed font-size of the destination element in px, so the clone's
   *  rendered glyphs match the landing element exactly (no size pop). */
  toFontSizePx: number;
  colors?: {
    from: WordmarkMorphColors;
    to: WordmarkMorphColors;
  };
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Shared-element FLIP morph for the OneShot wordmark. The caller measures
 * source + destination rects BEFORE any layout-changing state updates and
 * hands them in as pre-computed DOMRects, sidestepping timing races with
 * CSS transitions on the surrounding layout.
 *
 * The caller is also responsible for hiding the real source/destination
 * wordmarks via CSS (visibility: hidden) while this component is active,
 * so the clone isn't double-drawn.
 */
export function WordmarkMorph({
  rects,
  onDone,
  theme = "dark",
}: {
  rects: MorphRects | null;
  onDone: () => void;
  theme?: Theme;
}) {
  const cloneRef = useRef<HTMLHeadingElement | null>(null);

  useLayoutEffect(() => {
    if (!rects) return;
    const clone = cloneRef.current;
    if (!clone) return;
    let settled = false;

    if (prefersReducedMotion()) {
      onDone();
      return;
    }

    const { from, to, fromFontSizePx, toFontSizePx } = rects;
    const animations: Animation[] = [];

    clone.style.position = "fixed";
    clone.style.left = `${from.left}px`;
    clone.style.top = `${from.top}px`;
    clone.style.margin = "0";
    clone.style.fontSize = `${fromFontSizePx}px`;
    clone.style.transformOrigin = "top left";
    clone.style.transition = "none";
    clone.style.pointerEvents = "none";
    clone.style.willChange = "transform, font-size";
    clone.style.transform = "translate(0, 0)";
    const finalTransform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;

    const finish = () => {
      if (settled) return;
      settled = true;
      onDone();
    };

    const positionAnimation = clone.animate(
      [
        {
          fontSize: `${fromFontSizePx}px`,
          transform: "translate(0, 0)",
        },
        {
          fontSize: `${toFontSizePx}px`,
          transform: finalTransform,
        },
      ],
      {
        duration: DURATION_MS,
        easing: EASE,
        fill: "forwards",
      },
    );
    animations.push(positionAnimation);

    if (rects.colors) {
      for (const [key, selector] of WORDMARK_PARTS) {
        const part = clone.querySelector<HTMLElement>(selector);
        if (!part) continue;

        const fromColor = rects.colors.from[key];
        const toColor = rects.colors.to[key];
        part.style.color = fromColor;
        animations.push(
          part.animate(
            [{ color: fromColor }, { color: toColor }],
            {
              duration: DURATION_MS,
              easing: EASE,
              fill: "forwards",
            },
          ),
        );
      }
    }

    void Promise.allSettled(animations.map((active) => active.finished))
      .then(finish)
      .catch(() => {
        // Animation cancellation is expected when React unmounts the clone.
      });

    // Safety net for dropped animation finished promises.
    const timer = window.setTimeout(() => {
      finish();
    }, DURATION_MS + 80);

    return () => {
      settled = true;
      animations.forEach((active) => active.cancel());
      window.clearTimeout(timer);
    };
  }, [rects, onDone]);

  if (!rects) return null;

  return createPortal(
    <div
      className="liquid-glass-scope"
      data-theme={theme}
      aria-hidden="true"
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 80 }}
    >
      <h1
        ref={cloneRef}
        className="oneshot-wordmark"
        style={{ position: "fixed", top: 0, left: 0 }}
      >
        <span className="wm-one">One</span>
        <span className="wm-shot">Shot</span>
        <span className="wm-period">.</span>
      </h1>
    </div>,
    document.body,
  );
}
