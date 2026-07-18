import { useEffect, useState } from "react";

const COLORS = ["#7c5cff", "#22c55e", "#f59e0b", "#ef4444", "#3b82f6"];

/** Dependency-free confetti burst: ~40 CSS-animated pieces for ~2s. */
export function Confetti({ pieces = 40 }: { pieces?: number }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="sf-confetti" aria-hidden="true">
      {Array.from({ length: pieces }).map((_, i) => (
        <span
          key={i}
          className="sf-confetti-piece"
          style={{
            left: `${(i / pieces) * 100}%`,
            background: COLORS[i % COLORS.length],
            animationDelay: `${(i % 10) * 0.06}s`,
          }}
        />
      ))}
    </div>
  );
}
