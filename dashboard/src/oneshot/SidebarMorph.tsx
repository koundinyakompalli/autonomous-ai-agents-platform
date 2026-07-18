import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const EASE = "cubic-bezier(0.45, 0, 0.35, 1)";
const DURATION_MS = 820;
const FOCUSABLE_SELECTOR =
  "a, button, input, select, textarea, [tabindex], [contenteditable='true']";
type Theme = "light" | "dark";

export type SidebarMorphSnapshot = {
  direction: "enter" | "exit";
  from: DOMRect;
  to: DOMRect;
  html: string;
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SidebarMorph({
  snapshot,
  theme = "dark",
}: {
  snapshot: SidebarMorphSnapshot | null;
  theme?: Theme;
}) {
  const cloneRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!snapshot) return;
    const clone = cloneRef.current;
    if (!clone) return;

    clone.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR).forEach((node) => {
      node.setAttribute("tabindex", "-1");
    });

    if (prefersReducedMotion()) return;

    const { from, to, direction } = snapshot;
    const startOpacity = direction === "exit" ? 0 : 1;
    const endOpacity = direction === "exit" ? 1 : 0;
    const startFilter = direction === "exit" ? "blur(8px)" : "blur(0px)";
    const endFilter = direction === "exit" ? "blur(0px)" : "blur(8px)";
    const finalTransform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;

    clone.style.position = "fixed";
    clone.style.left = `${from.left}px`;
    clone.style.top = `${from.top}px`;
    clone.style.width = `${from.width}px`;
    clone.style.height = `${from.height}px`;
    clone.style.margin = "0";
    clone.style.pointerEvents = "none";
    clone.style.transform = "translate(0, 0)";
    clone.style.transformOrigin = "top left";
    clone.style.opacity = String(startOpacity);
    clone.style.filter = startFilter;
    clone.style.transition = "none";
    clone.style.willChange = "transform, opacity, filter";

    const animation = clone.animate(
      [
        {
          transform: "translate(0, 0)",
          opacity: startOpacity,
          filter: startFilter,
        },
        {
          transform: finalTransform,
          opacity: endOpacity,
          filter: endFilter,
        },
      ],
      {
        duration: DURATION_MS,
        easing: EASE,
        fill: "forwards",
      },
    );

    return () => {
      animation.cancel();
    };
  }, [snapshot]);

  if (!snapshot) return null;

  return createPortal(
    <div
      className="liquid-glass-scope sidebar-morph-layer"
      data-theme={theme}
      aria-hidden="true"
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 70 }}
    >
      <aside
        ref={cloneRef}
        className="sidebar sidebar-morph-shell"
        style={{
          position: "fixed",
          left: snapshot.from.left,
          top: snapshot.from.top,
          width: snapshot.from.width,
          height: snapshot.from.height,
          margin: 0,
          pointerEvents: "none",
          opacity: snapshot.direction === "exit" ? 0 : 1,
          filter: snapshot.direction === "exit" ? "blur(8px)" : "blur(0px)",
        }}
        dangerouslySetInnerHTML={{ __html: snapshot.html }}
      />
    </div>,
    document.body,
  );
}
