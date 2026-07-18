import { useRef, useCallback, useState, useEffect } from "react";
import { OfficeState } from "../office/engine/officeState.js";
import { OfficeCanvas } from "../office/components/OfficeCanvas.js";
import { NameTagOverlay } from "../NameTagOverlay.js";
import { EditorState } from "../office/editor/editorState.js";
import { useSpecterAgents } from "../useSpecterAgents.js";
import {
  useEditorActions,
  loadPersistedLayout,
} from "../hooks/useEditorActions.js";
import { migrateLayoutColors } from "../office/layout/layoutSerializer.js";
import { useEditorKeyboard } from "../hooks/useEditorKeyboard.js";
import { ZoomControls } from "../components/ZoomControls.js";
import { EditorToolbar } from "../office/editor/EditorToolbar.js";
import { isRotatable } from "../office/layout/furnitureCatalog.js";
import { EditTool, TILE_SIZE } from "../office/types.js";
import { PULSE_ANIMATION_DURATION_SEC, ZOOM_MAX } from "../constants.js";
import { HEIGHTS } from "../oneshot/pipelineStyles.js";

const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
    const saved = loadPersistedLayout();
    if (saved) officeStateRef.current.rebuildFromLayout(saved);
  }
  return officeStateRef.current;
}

const defaultLayoutPromise: Promise<void> = (() => {
  if (loadPersistedLayout()) return Promise.resolve();

  return fetch("/default-layout.json")
    .then((r) => r.json())
    .then((raw) => {
      const layout = raw.version === 1 ? migrateLayoutColors(raw) : raw;
      getOfficeState().rebuildFromLayout(layout);
    })
    .catch(() => {});
})();

function computeFitZoom(cols: number, rows: number): number {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mapW = cols * TILE_SIZE;
  const mapH = rows * TILE_SIZE;
  const margin = 0.97;
  return Math.min((vw / mapW) * margin, (vh / mapH) * margin);
}

export function OfficePage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  const [fitZoom, setFitZoom] = useState(1);
  const fitZoomRef = useRef(1);

  const editor = useEditorActions(getOfficeState, editorState);
  const { characterIds, agentLabels, layoutReady } = useSpecterAgents(
    getOfficeState,
    defaultLayoutPromise,
  );

  const handleEditorTickUpdate = useCallback(
    () => setEditorTickForKeyboard((n) => n + 1),
    [],
  );
  const handleCanvasClick = useCallback(() => {}, []);

  useEffect(() => {
    if (!layoutReady) return;

    const update = () => {
      const layout = getOfficeState().getLayout();
      const fz = computeFitZoom(layout.cols, layout.rows);
      fitZoomRef.current = fz;
      setFitZoom(fz);
      if (editor.zoom < fz) {
        editor.handleZoomChange(fz);
        editor.panRef.current = { x: 0, y: 0 };
      }
    };

    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [layoutReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!layoutReady) return;
    const layout = getOfficeState().getLayout();
    const fz = computeFitZoom(layout.cols, layout.rows);
    fitZoomRef.current = fz;
    setFitZoom(fz);
    editor.handleZoomChange(fz);
    editor.panRef.current = { x: 0, y: 0 };
  }, [layoutReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleZoomChange = useCallback(
    (z: number) => {
      const clamped = Math.max(fitZoomRef.current, Math.min(ZOOM_MAX, z));
      editor.handleZoomChange(clamped);
      if (clamped <= fitZoomRef.current) {
        editor.panRef.current = { x: 0, y: 0 };
      }
    },
    [editor],
  );

  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    handleEditorTickUpdate,
    editor.handleToggleEditMode,
  );

  void editorTickForKeyboard;

  const officeState = getOfficeState();

  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#7070a0",
          fontFamily: "monospace",
          fontSize: 14,
          background: "#1a1a2e",
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        background: "#1a1a2e",
      }}
    >
      <style>{`
        @keyframes pixel-agents-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .pixel-agents-pulse { animation: pixel-agents-pulse ${PULSE_ANIMATION_DURATION_SEC}s ease-in-out infinite; }
      `}</style>

      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <OfficeCanvas
          officeState={officeState}
          onClick={handleCanvasClick}
          isEditMode={editor.isEditMode}
          editorState={editorState}
          onEditorTileAction={editor.handleEditorTileAction}
          onEditorEraseAction={editor.handleEditorEraseAction}
          onEditorSelectionChange={editor.handleEditorSelectionChange}
          onDeleteSelected={editor.handleDeleteSelected}
          onRotateSelected={editor.handleRotateSelected}
          onDragMove={editor.handleDragMove}
          editorTick={editor.editorTick}
          zoom={editor.zoom}
          onZoomChange={handleZoomChange}
          panRef={editor.panRef}
          fitZoom={fitZoom}
        />

        <NameTagOverlay
          officeState={officeState}
          characterIds={characterIds}
          agentLabels={agentLabels}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
        />

        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.75) 100%)",
            pointerEvents: "none",
            zIndex: 40,
          }}
        />

        <div
          style={{
            position: "absolute",
            top: 20,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 50,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 0 }}>
            <span
              style={{
                fontSize: 32,
                fontWeight: 900,
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                color: "#ffffff",
                letterSpacing: "-0.02em",
                textShadow: "0 2px 20px rgba(0,0,0,0.8)",
              }}
            >
              Product
            </span>
            <span
              style={{
                fontSize: 32,
                fontWeight: 900,
                fontStyle: "italic",
                fontFamily:
                  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                color: "#4ECDC4",
                letterSpacing: "-0.02em",
                marginLeft: 8,
                textShadow: "0 2px 20px rgba(0,0,0,0.8)",
              }}
            >
              Factory
            </span>
          </div>
        </div>

        <ZoomControls zoom={editor.zoom} onZoomChange={handleZoomChange} />

        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 12,
            fontSize: 10,
            fontFamily: "monospace",
            color: "rgba(100,100,160,0.4)",
            pointerEvents: "none",
            zIndex: 50,
          }}
        >
          SPECTER
        </div>

        {editor.isEditMode && (
          <>
            {editor.isDirty && (
              <div
                style={{
                  position: "absolute",
                  top: 8,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 49,
                  display: "flex",
                  gap: 4,
                  background: "rgba(14,14,28,0.9)",
                  border: "2px solid #444466",
                  padding: "4px 8px",
                }}
              >
                <button
                  onClick={editor.handleUndo}
                  style={btnStyle}
                  disabled={editorState.undoStack.length === 0}
                >
                  Undo
                </button>
                <button
                  onClick={editor.handleRedo}
                  style={btnStyle}
                  disabled={editorState.redoStack.length === 0}
                >
                  Redo
                </button>
                <button onClick={editor.handleSave} style={btnStyle}>
                  Save
                </button>
                <button onClick={editor.handleReset} style={btnStyle}>
                  Reset
                </button>
              </div>
            )}
            {showRotateHint && (
              <div
                style={{
                  position: "absolute",
                  top: 8,
                  left: "50%",
                  transform: editor.isDirty
                    ? "translateX(calc(-50% + 100px))"
                    : "translateX(-50%)",
                  zIndex: 49,
                  background: "rgba(14,14,28,0.9)",
                  color: "#fff",
                  fontSize: 11,
                  padding: "3px 8px",
                  border: "2px solid #4488CC",
                  pointerEvents: "none",
                }}
              >
                Press <b>R</b> to rotate
              </div>
            )}
            <EditorToolbar
              activeTool={editorState.activeTool}
              selectedTileType={editorState.selectedTileType}
              selectedFurnitureType={editorState.selectedFurnitureType}
              selectedFurnitureUid={editorState.selectedFurnitureUid}
              selectedFurnitureColor={
                editorState.selectedFurnitureUid
                  ? (officeState
                      .getLayout()
                      .furniture.find(
                        (f) => f.uid === editorState.selectedFurnitureUid,
                      )?.color ?? null)
                  : null
              }
              floorColor={editorState.floorColor}
              wallColor={editorState.wallColor}
              onToolChange={editor.handleToolChange}
              onTileTypeChange={editor.handleTileTypeChange}
              onFloorColorChange={editor.handleFloorColorChange}
              onWallColorChange={editor.handleWallColorChange}
              onSelectedFurnitureColorChange={
                editor.handleSelectedFurnitureColorChange
              }
              onFurnitureTypeChange={editor.handleFurnitureTypeChange}
              loadedAssets={undefined}
            />
          </>
        )}

        <button
          onClick={editor.handleToggleEditMode}
          style={{
            position: "absolute",
            bottom: 12,
            left: 12,
            fontSize: 10,
            fontFamily: "monospace",
            background: editor.isEditMode
              ? "rgba(68,136,204,0.2)"
              : "rgba(14,14,28,0.7)",
            color: editor.isEditMode ? "#4488CC" : "rgba(100,100,160,0.6)",
            border: `1px solid ${editor.isEditMode ? "#4488CC" : "rgba(80,80,120,0.3)"}`,
            padding: "3px 8px",
            cursor: "pointer",
            zIndex: 50,
          }}
        >
          {editor.isEditMode ? "EDITING" : "EDIT LAYOUT"}
        </button>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  height: HEIGHTS.compact,
  padding: "0 10px",
  fontSize: 11,
  background: "rgba(30,30,50,0.9)",
  color: "#a0a0c0",
  border: "1px solid #444466",
  cursor: "pointer",
  fontFamily: "monospace",
};
