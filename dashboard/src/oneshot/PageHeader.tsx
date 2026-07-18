import type { ReactNode } from "react";

export type PageHeaderMetric = {
  label: string;
  value: ReactNode;
  tone?: "default" | "accent" | "ok" | "warn" | "bad";
};

export function PageHeader({
  title,
  subtitle,
  metrics,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  metrics?: ReadonlyArray<PageHeaderMetric>;
  actions?: ReactNode;
}) {
  return (
    <div className="view-header">
      <div className="view-header-copy">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <div className="page-sub dim">{subtitle}</div> : null}
        {metrics && metrics.length > 0 && (
          <div className="page-metrics" aria-label={`${title} metrics`}>
            {metrics.map((metric) => (
              <span
                key={metric.label}
                className={`page-metric-chip ${metric.tone ?? "default"}`}
              >
                <span className="page-metric-label">{metric.label}</span>
                <span className="page-metric-value">{metric.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {actions}
    </div>
  );
}
