import type { Ref } from "react";
import type { UiTab } from "./viewTabDefs.js";
import {
  BookOpen,
  Cpu,
  Gauge,
  ICON_SIZE,
  ICON_STROKE,
  LayoutGrid,
  List,
  Sparkles,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "./icons.js";

type VisibleTab =
  | "overview"
  | "runs"
  | "agents"
  | "queue"
  | "throughput"
  | "costs"
  | "statistics"
  | "about";

/**
 * Sidebar follows the prototype information architecture exactly:
 * Overview / Runs / Agents / Queue in the workspace group, and
 * Throughput / Costs / Statistics in the analytics group.
 *
 * Legacy deep links like `?view=history` are normalized to the visible `Runs`
 * item by the page route before they reach this component.
 */
export function Sidebar({
  uiTab,
  onSelect,
  shellRef,
  wordmarkRef,
}: {
  uiTab: UiTab;
  onSelect: (next: VisibleTab) => void;
  shellRef?: Ref<HTMLElement>;
  wordmarkRef?: Ref<HTMLHeadingElement>;
}) {
  const visibleTab: VisibleTab =
    uiTab === "running" ||
    uiTab === "queued" ||
    uiTab === "waiting" ||
    uiTab === "history"
      ? "runs"
      : uiTab;

  const workspaceItems: ReadonlyArray<{
    id: VisibleTab;
    Icon: LucideIcon;
    label: string;
  }> = [
    { id: "overview", Icon: Gauge, label: "Overview" },
    { id: "runs", Icon: List, label: "Runs" },
    { id: "agents", Icon: Cpu, label: "Agents" },
    { id: "queue", Icon: LayoutGrid, label: "Queue" },
  ];

  const analyticsItems: ReadonlyArray<{
    id: VisibleTab;
    Icon: LucideIcon;
    label: string;
  }> = [
    { id: "throughput", Icon: TrendingUp, label: "Throughput" },
    { id: "costs", Icon: TrendingDown, label: "Costs" },
    { id: "statistics", Icon: Sparkles, label: "Statistics" },
  ];

  const footerItems: ReadonlyArray<{
    id: VisibleTab;
    Icon: LucideIcon;
    label: string;
  }> = [{ id: "about", Icon: BookOpen, label: "Guide" }];

  const renderItem = (item: {
    id: VisibleTab;
    Icon: LucideIcon;
    label: string;
  }) => {
    const active = item.id === visibleTab;
    return (
      <button
        key={item.id}
        type="button"
        className={`nav-item${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(item.id)}
      >
        <span className="nav-icon" aria-hidden="true">
          <item.Icon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
        </span>
        <span className="nav-label">{item.label}</span>
      </button>
    );
  };

  return (
    <aside ref={shellRef} className="sidebar" aria-label="Primary navigation">
      <div className="brand oneshot-brand">
        <h1 ref={wordmarkRef} className="oneshot-wordmark" aria-label="OneShot">
          <span className="wm-one">One</span>
          <span className="wm-shot">Shot</span>
          <span className="wm-period" aria-hidden="true">
            .
          </span>
        </h1>
        <p className="oneshot-tagline">Autonomous Feature Delivery Pipeline</p>
      </div>

      <nav className="nav" aria-label="Dashboard sections">
        <div className="nav-group">
          <div className="nav-group-label mono">workspace</div>
          {workspaceItems.map(renderItem)}
        </div>

        <div className="nav-group">
          <div className="nav-group-label mono">analytics</div>
          {analyticsItems.map(renderItem)}
        </div>

        <div className="nav-group nav-group-footer">
          {footerItems.map(renderItem)}
        </div>
      </nav>
    </aside>
  );
}
