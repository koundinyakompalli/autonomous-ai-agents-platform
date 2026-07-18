import { useState, useEffect } from "react";
import type { ToolActivity } from "../types.js";
import type { OfficeState } from "../engine/officeState.js";
import { TILE_SIZE, CharacterState } from "../types.js";
import {
  TOOL_OVERLAY_VERTICAL_OFFSET,
  CHARACTER_SITTING_OFFSET_PX,
} from "../../constants.js";
import { HEIGHTS } from "../../oneshot/pipelineStyles.js";

type AgentType = "claude" | "codex";

interface SubagentCharacter {
  id: number;
  label: string;
}

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  agentTypes: Record<number, AgentType>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
): string {
  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return "Needs approval";
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return "Idle";
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  agentTypes,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
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

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;

        // Only show for hovered or selected agents
        if (!isSelected && !isHovered) return null;

        // Position above character
        const sittingOffset =
          ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
        const screenY =
          (deviceOffsetY +
            (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) /
          dpr;

        // Get activity text
        const subHasPermission = isSub && ch.bubbleType === "permission";
        let activityText: string;
        if (isSub) {
          if (subHasPermission) {
            activityText = "Needs approval";
          } else {
            const sub = subagentCharacters.find((s) => s.id === id);
            activityText = sub ? sub.label : "Subtask";
          }
        } else {
          activityText = getActivityText(id, agentTools, ch.isActive);
        }

        // Check agent type for visual distinction
        const isCodex = !isSub && agentTypes[id] === "codex";

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission =
          subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;

        let dotColor: string | null = null;
        if (hasPermission) {
          dotColor = "var(--pixel-status-permission)";
        } else if (isActive && hasActiveTools) {
          dotColor = "var(--pixel-status-active)";
        }

        return (
          <div
            key={id}
            style={{
              position: "absolute",
              left: screenX,
              top: screenY - 24,
              transform: "translateX(-50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              pointerEvents: isSelected ? "auto" : "none",
              zIndex: isSelected
                ? "var(--pixel-overlay-selected-z)"
                : "var(--pixel-overlay-z)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "var(--pixel-bg)",
                border: isCodex
                  ? "2px solid var(--pixel-green)"
                  : isSelected
                    ? "2px solid var(--pixel-border-light)"
                    : "2px solid var(--pixel-border)",
                borderRadius: 0,
                height: HEIGHTS.pill,
                padding: "0 8px",
                boxShadow: "var(--pixel-shadow)",
                whiteSpace: "nowrap",
                maxWidth: 220,
              }}
            >
              {dotColor && (
                <span
                  className={
                    isActive && !hasPermission
                      ? "pixel-agents-pulse"
                      : undefined
                  }
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: dotColor,
                    flexShrink: 0,
                  }}
                />
              )}
              <span
                style={{
                  fontSize: isSub ? "20px" : "22px",
                  fontStyle: isSub ? "italic" : undefined,
                  color: "var(--pixel-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {activityText}
              </span>
              {isSelected && !isSub && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseAgent(id);
                  }}
                  title="Close agent"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--pixel-close-text)",
                    cursor: "pointer",
                    padding: "0 2px",
                    fontSize: "26px",
                    lineHeight: 1,
                    marginLeft: 2,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color =
                      "var(--pixel-close-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color =
                      "var(--pixel-close-text)";
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
