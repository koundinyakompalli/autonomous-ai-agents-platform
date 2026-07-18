import { HEIGHTS, RADII } from "../oneshot/pipelineStyles.js";

interface DashboardNavProps {
  currentPath:
    | "/"
    | "/oneshot"
    | "/production-support"
    | "/product-catalog"
    | "/spec-factory"
    | "/watchdog"
    | "/watchdog/intro"
    | "/investigation";
  onNavigate: (path: DashboardNavProps["currentPath"]) => void;
  variant?: "floating" | "inline";
  items?: Array<{
    path: DashboardNavProps["currentPath"];
    label: string;
  }>;
}

const navButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: "0 16px",
  height: HEIGHTS.control,
  borderRadius: RADII.pill,
  border: "none",
  background: active ? "rgba(255,255,255,0.10)" : "transparent",
  color: active ? "#ffffff" : "rgba(255,255,255,0.58)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: active ? "default" : "pointer",
  fontFamily: "'JetBrains Mono', monospace",
  whiteSpace: "nowrap",
  transition: "color 0.2s ease, background 0.2s ease",
});

export function DashboardNav({
  currentPath,
  onNavigate,
  variant = "floating",
  items,
}: DashboardNavProps) {
  const navItems = items ?? [
    { path: "/", label: "Floor" },
    { path: "/oneshot", label: "OneShot" },
    { path: "/product-catalog", label: "Product Catalog" },
    { path: "/spec-factory", label: "Spec Factory" },
    { path: "/investigation", label: "Investigation" },
    { path: "/watchdog", label: "Watchdog" },
    { path: "/production-support", label: "Production Support" },
  ];
  const floating: React.CSSProperties = {
    position: "fixed",
    bottom: 20,
    right: 20,
    zIndex: 200,
    background: "rgba(20,20,22,0.82)",
    border: "1px solid rgba(255,255,255,0.06)",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
  };
  const inline: React.CSSProperties = {
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.06)",
  };
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 2,
        justifyContent: "flex-end",
        maxWidth: "calc(100vw - 40px)",
        padding: 3,
        borderRadius: RADII.pill,
        ...(variant === "floating" ? floating : inline),
      }}
    >
      {navItems.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={() => onNavigate(item.path)}
          disabled={currentPath === item.path}
          aria-current={currentPath === item.path ? "page" : undefined}
          title={currentPath === item.path ? "Current view" : undefined}
          style={navButtonStyle(currentPath === item.path)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
