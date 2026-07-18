import { useEffect, useRef } from "react";
import type {
  ComposeCanonicalEvent,
  ComposeStreamEvent,
} from "./composeTypes.js";

const EVENT_TYPES = [
  "status",
  "message",
  "readiness",
  "invalidate",
  "session",
] as const;
const DEFAULT_STUCK_TIMEOUT_MS = 90_000;

export interface UseComposeStreamOptions {
  /** Fired whenever the EventSource (re)opens (initial connect or auto-reconnect). */
  onOpen?: () => void;
  /** Fired when the EventSource reports an error. EventSource will auto-reconnect. */
  onError?: () => void;
  onCanonicalEvent?: (event: ComposeCanonicalEvent) => void;
  /**
   * Fired when no event has arrived for `stuckTimeoutMs` while the connection is open.
   * Useful for clearing a stale `thinking` UI flag when the idle event was dropped.
   */
  onStuck?: () => void;
  /** Watchdog timeout. Defaults to 90 seconds. Use `0` or a negative number to disable. */
  stuckTimeoutMs?: number;
}

/**
 * Subscribe to a Compose session's SSE stream. Calls `onEvent` for each
 * status/message/readiness event. No-op when sessionId is null. The latest
 * onEvent is held in a ref so the EventSource is only re-created when the
 * session changes.
 *
 * Optional callbacks help the consumer reconcile state across reconnects:
 *  - `onOpen` fires on every (re)connect — re-fetch messages/readiness here.
 *  - `onError` fires on transport errors (EventSource will auto-reconnect).
 *  - `onStuck` fires after `stuckTimeoutMs` of silence so the UI can clear
 *    stale "thinking" state when the closing idle event was dropped.
 */
export function useComposeStream(
  sessionId: number | null,
  onEvent: (event: ComposeStreamEvent) => void,
  options: UseComposeStreamOptions = {},
  token?: string | null,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (sessionId === null) return;
    if (typeof EventSource === "undefined") return;

    const url = token
      ? `/api/spec-factory/compose/sessions/${sessionId}/stream?token=${encodeURIComponent(token)}`
      : `/api/spec-factory/compose/sessions/${sessionId}/stream`;
    const source = new EventSource(url);

    let stuckTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStuckTimer = () => {
      if (stuckTimer !== null) {
        clearTimeout(stuckTimer);
        stuckTimer = null;
      }
    };
    const armStuckTimer = () => {
      clearStuckTimer();
      const timeout = optionsRef.current.stuckTimeoutMs;
      const resolved =
        typeof timeout === "number" ? timeout : DEFAULT_STUCK_TIMEOUT_MS;
      if (!optionsRef.current.onStuck) return;
      if (!Number.isFinite(resolved) || resolved <= 0) return;
      stuckTimer = setTimeout(() => {
        stuckTimer = null;
        optionsRef.current.onStuck?.();
      }, resolved);
    };

    const listeners: Array<[string, (ev: MessageEvent) => void]> = [];
    for (const type of EVENT_TYPES) {
      const listener = (ev: MessageEvent) => {
        try {
          const event = JSON.parse(ev.data) as ComposeStreamEvent;
          // Reset / disable the watchdog as state moves through the stream:
          // re-arm while still working, clear when idle.
          if (
            event.type === "status" &&
            (event.status === "idle" || event.status === "error")
          ) {
            clearStuckTimer();
          } else {
            armStuckTimer();
          }
          handlerRef.current(event);
        } catch {
          // ignore malformed event payloads
        }
      };
      source.addEventListener(type, listener as EventListener);
      listeners.push([type, listener]);
    }
    const canonicalListener = (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data) as ComposeCanonicalEvent;
        if (
          event.schemaVersion !== 1 ||
          typeof event.id !== "number" ||
          typeof event.eventType !== "string"
        ) {
          return;
        }
        optionsRef.current.onCanonicalEvent?.(event);
        const data = event.data as Partial<ComposeStreamEvent> | null;
        if (data && typeof data === "object" && typeof data.type === "string") {
          handlerRef.current(data as ComposeStreamEvent);
        }
      } catch {
        // Ignore malformed live fanout; durable reconnect will replay valid rows.
      }
    };
    source.addEventListener("canonical", canonicalListener as EventListener);
    listeners.push(["canonical", canonicalListener]);

    const handleOpen = () => {
      // EventSource auto-reconnects; consumer should reconcile state on every open.
      armStuckTimer();
      optionsRef.current.onOpen?.();
    };
    const handleError = () => {
      clearStuckTimer();
      try {
        optionsRef.current.onError?.();
      } catch {
        // never let a consumer error crash the stream lifecycle
      }
    };
    source.onopen = handleOpen;
    source.onerror = handleError;

    return () => {
      clearStuckTimer();
      source.onopen = null;
      source.onerror = null;
      for (const [type, listener] of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
    };
  }, [sessionId, token]);
}
