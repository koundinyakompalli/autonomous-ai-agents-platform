import { useEffect, useRef } from "react";

export interface VantaWavesBackgroundProps {
  className?: string;
  animated?: boolean;
  maxDevicePixelRatio?: number;
  targetFps?: number;
  variant?: "compose" | "workspace";
  waveCount?: number;
}

const COMPOSE_RIBBON_COLORS: readonly string[] = [
  "rgba(68, 200, 189, 0.18)",
  "rgba(84, 188, 232, 0.18)",
  "rgba(98, 81, 172, 0.12)",
  "rgba(255, 191, 63, 0.12)",
];

const WORKSPACE_RIBBON_COLORS: readonly string[] = [
  "rgba(68, 200, 189, 0.2)",
  "rgba(51, 141, 201, 0.18)",
  "rgba(98, 81, 172, 0.14)",
  "rgba(255, 191, 63, 0.1)",
];

export function VantaWavesBackground({
  animated = true,
  className,
  maxDevicePixelRatio = 1.5,
  targetFps = 30,
  variant = "compose",
  waveCount = 9,
}: VantaWavesBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<number>(
    typeof performance === "undefined" ? Date.now() : performance.now(),
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    if (window.navigator.userAgent.includes("jsdom")) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const paintContext = ctx;

    let cssWidth = 0;
    let cssHeight = 0;
    let dpr = Math.min(
      maxDevicePixelRatio,
      Math.max(1, window.devicePixelRatio || 1),
    );
    const isWorkspace = variant === "workspace";
    const ribbonColors = isWorkspace
      ? WORKSPACE_RIBBON_COLORS
      : COMPOSE_RIBBON_COLORS;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      dpr = Math.min(
        maxDevicePixelRatio,
        Math.max(1, window.devicePixelRatio || 1),
      );
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!animated) {
        window.setTimeout(() => paint(), 0);
      }
    };

    let cleanupResize = () => {};
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      cleanupResize = () => observer.disconnect();
    } else {
      window.addEventListener("resize", resize);
      cleanupResize = () => window.removeEventListener("resize", resize);
    }
    resize();

    const drawDotField = (time: number) => {
      const spacing = animated ? 30 : 28;
      for (let x = 0; x < cssWidth; x += spacing) {
        for (let y = 0; y < cssHeight; y += spacing) {
          const shimmer =
            (isWorkspace ? 0.14 : 0.2) +
            0.12 * Math.sin(x * 0.014 + y * 0.018 + time * 0.55);
          ctx.fillStyle = `rgba(83,75,124,${Math.max(shimmer * 0.28, 0.025).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const drawWave = (index: number, time: number) => {
      const phase = time * (0.22 + index * 0.012);
      const base =
        cssHeight *
        ((isWorkspace ? 0.4 : 0.56) + index * (isWorkspace ? 0.052 : 0.045));
      const amplitude =
        cssHeight *
        ((isWorkspace ? 0.074 : 0.05) +
          (index % 3) * (isWorkspace ? 0.016 : 0.012));
      const frequency = 1.7 + index * 0.18;
      const skew = index * 38;
      const steps = isWorkspace ? 84 : 72;
      const width = Math.max(cssWidth, 1);

      ctx.beginPath();
      ctx.moveTo(-80, cssHeight + 80);
      ctx.lineTo(-80, base);

      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps;
        const x = progress * (cssWidth + 160) - 80;
        const normalized = (x + skew) / width;
        const y =
          base +
          Math.sin((normalized * frequency + phase) * Math.PI * 2) * amplitude +
          Math.cos((normalized * 2.5 - phase * 0.7) * Math.PI * 2) *
            amplitude *
            0.36;
        ctx.lineTo(x, y);
      }

      ctx.lineTo(cssWidth + 80, cssHeight + 80);
      ctx.closePath();
      ctx.fillStyle = ribbonColors[index % ribbonColors.length];
      ctx.fill();

      ctx.beginPath();
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps;
        const x = progress * (cssWidth + 160) - 80;
        const normalized = (x + skew) / width;
        const y =
          base +
          Math.sin((normalized * frequency + phase) * Math.PI * 2) * amplitude +
          Math.cos((normalized * 2.5 - phase * 0.7) * Math.PI * 2) *
            amplitude *
            0.36;
        if (step === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = isWorkspace
        ? "rgba(98,81,172,0.12)"
        : "rgba(51,141,201,0.11)";
      ctx.lineWidth = 1;
      ctx.stroke();
    };

    const drawOverlays = () => {
      const linear = ctx.createLinearGradient(0, 0, 0, cssHeight);
      linear.addColorStop(
        0,
        isWorkspace ? "rgba(255, 255, 255, 0.72)" : "rgba(255, 255, 255, 0.82)",
      );
      linear.addColorStop(0.48, "rgba(255, 255, 255, 0.12)");
      linear.addColorStop(
        1,
        isWorkspace ? "rgba(84, 188, 232, 0.16)" : "rgba(98, 81, 172, 0.08)",
      );
      ctx.fillStyle = linear;
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      const radial = ctx.createRadialGradient(
        cssWidth / 2,
        0,
        60,
        cssWidth / 2,
        0,
        520,
      );
      radial.addColorStop(
        0,
        isWorkspace ? "rgba(68,200,189,0.12)" : "rgba(98,81,172,0.08)",
      );
      radial.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, cssWidth, cssHeight);
    };

    function paint() {
      const now =
        typeof performance === "undefined" ? Date.now() : performance.now();
      const elapsed = (now - startRef.current) / 1000;
      const time = animated ? elapsed : 9.75;

      paintContext.fillStyle = isWorkspace
        ? "rgb(255, 255, 255)"
        : "rgb(250, 252, 255)";
      paintContext.fillRect(0, 0, cssWidth, cssHeight);
      drawDotField(time);
      for (let i = 0; i < waveCount; i += 1) drawWave(i, time);
      drawOverlays();
    }

    const requestFrame = (callback: FrameRequestCallback) => {
      if (window.requestAnimationFrame)
        return window.requestAnimationFrame(callback);
      return window.setTimeout(() => callback(Date.now()), 16);
    };
    const cancelFrame = (handle: number) => {
      if (window.cancelAnimationFrame) window.cancelAnimationFrame(handle);
      else window.clearTimeout(handle);
    };
    const shouldAnimate =
      animated &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches &&
      !window.navigator.userAgent.includes("jsdom");
    const frameInterval = Math.max(16, Math.round(1000 / targetFps));
    let lastFrame = 0;

    const render = (timestamp: number) => {
      if (timestamp - lastFrame >= frameInterval) {
        lastFrame = timestamp;
        paint();
      }
      frameRef.current = requestFrame(render);
    };

    paint();
    if (shouldAnimate) frameRef.current = requestFrame(render);

    return () => {
      if (frameRef.current !== null) cancelFrame(frameRef.current);
      cleanupResize();
    };
  }, [animated, maxDevicePixelRatio, targetFps, variant, waveCount]);

  return (
    <div
      ref={containerRef}
      className={["sf-vanta-waves", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="sf-vanta-canvas" />
    </div>
  );
}
