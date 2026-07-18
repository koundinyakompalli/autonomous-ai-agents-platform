import { useState, useEffect } from "react";
import type { OfficeState } from "./office/engine/officeState.js";
import type { AgentLabel } from "./useSpecterAgents.js";
import { CharacterState, TILE_SIZE } from "./office/types.js";
import { CHARACTER_SITTING_OFFSET_PX } from "./constants.js";
import { HEIGHTS } from "./oneshot/pipelineStyles.js";

const TAG_VERTICAL_OFFSET_PX = 28;

const STATUS_COLORS: Record<string, string> = {
  in_progress: "#44BB66",
  assigned: "#CCAA33",
  posting_to_jira: "#4488CC",
  failed: "#CC4444",
};

function liveElapsed(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface NameTagOverlayProps {
  officeState: OfficeState;
  characterIds: number[];
  agentLabels: Record<number, AgentLabel>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

export function NameTagOverlay({
  officeState,
  characterIds,
  agentLabels,
  containerRef,
  zoom,
  panRef,
}: NameTagOverlayProps) {
  // RAF tick: updates character positions + live elapsed time
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const pan = panRef.current ?? { x: 0, y: 0 };
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(pan.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(pan.y);

  // The canvas sets selectedAgentId on click — use it to expand details
  const selectedId = officeState.selectedAgentId;

  return (
    <>
      {characterIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch || ch.matrixEffect === "despawn") return null;

        const label = agentLabels[id];
        if (!label) return null;

        const isSelected = selectedId === id;
        const isActive = ch.isActive;
        const isFailed = label.isFailed ?? false;
        const sittingOffset =
          ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
        const screenY =
          (deviceOffsetY +
            (ch.y + sittingOffset - TAG_VERTICAL_OFFSET_PX) * zoom) /
          dpr;

        const dotColor = label.status ? STATUS_COLORS[label.status] : null;
        const borderColor = isFailed
          ? "rgba(180,60,60,0.7)"
          : isSelected
            ? "rgba(160,200,255,0.8)"
            : isActive
              ? "rgba(100,180,100,0.6)"
              : "rgba(80,80,120,0.4)";

        const nameColor = isFailed
          ? "#ff8888"
          : isActive
            ? "#e0e0ff"
            : "#7070a0";

        const elapsed = label.createdAt
          ? liveElapsed(label.createdAt)
          : undefined;

        return (
          <div
            key={id}
            style={{
              position: "absolute",
              left: screenX,
              top: screenY,
              transform: "translateX(-50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              pointerEvents: "none",
              zIndex: isSelected ? 20 : 10,
            }}
          >
            {/* Always-visible: status dot + agent name only */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: isFailed
                  ? "rgba(40,14,14,0.9)"
                  : "rgba(14,14,28,0.85)",
                border: `1px solid ${borderColor}`,
                height: HEIGHTS.pill,
                padding: "0 8px",
                whiteSpace: "nowrap",
                boxShadow: isSelected
                  ? `0 0 8px rgba(160,200,255,0.3)`
                  : "0 1px 4px rgba(0,0,0,0.6)",
              }}
            >
              {dotColor && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: dotColor,
                    flexShrink: 0,
                    boxShadow: `0 0 4px ${dotColor}`,
                  }}
                />
              )}
              <span
                style={{
                  fontSize: 10,
                  fontFamily: '"Press Start 2P", monospace, sans-serif',
                  fontWeight: 700,
                  color: nameColor,
                  letterSpacing: "0.02em",
                }}
              >
                {label.agentName}
              </span>
            </div>

            {/* Expanded details — only when character is selected (clicked) */}
            {isSelected && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  background: isFailed
                    ? "rgba(40,14,14,0.92)"
                    : "rgba(14,14,28,0.92)",
                  border: `1px solid ${borderColor}`,
                  borderTop: "none",
                  padding: "3px 8px 4px",
                  whiteSpace: "nowrap",
                  gap: 2,
                }}
              >
                {/* Idle agent — no active task */}
                {!isActive && !isFailed && !label.jiraTicket && (
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: "monospace",
                      color: "#606080",
                      fontStyle: "italic",
                    }}
                  >
                    Idle
                  </span>
                )}
                {label.jiraTicket && (
                  <span
                    style={{
                      fontSize: 10,
                      fontFamily: "monospace",
                      fontWeight: 700,
                      color: isFailed ? "#ff6666" : "#88aaff",
                    }}
                  >
                    {label.jiraTicket}
                  </span>
                )}
                {label.customer && (
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: "monospace",
                      color: isFailed ? "#bb7070" : "#9090b0",
                    }}
                  >
                    {label.customer}
                    {label.branch ? ` · ${label.branch}` : ""}
                  </span>
                )}
                {elapsed && (
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: "monospace",
                      color: isFailed ? "#994444" : "#606080",
                    }}
                  >
                    {elapsed}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
