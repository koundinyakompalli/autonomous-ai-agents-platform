// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useComposeStream } from "./useComposeStream.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners: Record<string, (ev: { data: string }) => void> = {};
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    this.listeners[type] = cb;
  }
  removeEventListener(type: string) {
    delete this.listeners[type];
  }
  emit(type: string, data: unknown) {
    this.listeners[type]?.({ data: JSON.stringify(data) });
  }
  emitOpen() {
    this.onopen?.(new Event("open"));
  }
  emitError() {
    this.onerror?.(new Event("error"));
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposeStream", () => {
  it("opens an EventSource for the session stream and reports events", () => {
    const onEvent = vi.fn();
    renderHook(() => useComposeStream(7, onEvent));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(
      "/api/spec-factory/compose/sessions/7/stream",
    );

    act(() => {
      FakeEventSource.instances[0].emit("message", {
        type: "message",
        role: "assistant",
        content: "hi",
      });
      FakeEventSource.instances[0].emit("readiness", {
        type: "readiness",
        readiness: { ready: true, openQuestions: [], summary: "ok" },
      });
      FakeEventSource.instances[0].emit("invalidate", {
        type: "invalidate",
        resource: "readiness",
      });
      FakeEventSource.instances[0].emit("status", {
        type: "status",
        status: "thinking",
      });
    });

    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onEvent.mock.calls[0][0]).toEqual({
      type: "message",
      role: "assistant",
      content: "hi",
    });
    expect(onEvent.mock.calls[1][0].type).toBe("readiness");
    expect(onEvent.mock.calls[2][0]).toEqual({
      type: "invalidate",
      resource: "readiness",
    });
    expect(onEvent.mock.calls[3][0].status).toBe("thinking");
  });

  it("does not open a stream when sessionId is null", () => {
    renderHook(() => useComposeStream(null, vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() => useComposeStream(7, vi.fn()));
    const es = FakeEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });

  it("invokes onOpen when the stream (re)connects", () => {
    const onOpen = vi.fn();
    renderHook(() => useComposeStream(7, vi.fn(), { onOpen }));
    act(() => {
      FakeEventSource.instances[0].emitOpen();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("invokes onError without crashing when the stream errors", () => {
    const onError = vi.fn();
    renderHook(() => useComposeStream(7, vi.fn(), { onError }));
    expect(() =>
      act(() => {
        FakeEventSource.instances[0].emitError();
      }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("invokes onStuck after a watchdog timeout when no events arrive", () => {
    vi.useFakeTimers();
    try {
      const onStuck = vi.fn();
      const onEvent = vi.fn();
      renderHook(() =>
        useComposeStream(7, onEvent, {
          onStuck,
          stuckTimeoutMs: 90_000,
        }),
      );
      act(() => {
        FakeEventSource.instances[0].emit("status", {
          type: "status",
          status: "thinking",
        });
      });
      expect(onStuck).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(89_000);
      });
      expect(onStuck).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(onStuck).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire onStuck when the assistant goes idle in time", () => {
    vi.useFakeTimers();
    try {
      const onStuck = vi.fn();
      renderHook(() =>
        useComposeStream(7, vi.fn(), {
          onStuck,
          stuckTimeoutMs: 90_000,
        }),
      );
      act(() => {
        FakeEventSource.instances[0].emit("status", {
          type: "status",
          status: "thinking",
        });
      });
      act(() => {
        vi.advanceTimersByTime(30_000);
        FakeEventSource.instances[0].emit("status", {
          type: "status",
          status: "idle",
        });
        vi.advanceTimersByTime(120_000);
      });
      expect(onStuck).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends the token query param to the stream URL when provided", () => {
    const created: string[] = [];
    class StubEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        created.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", StubEventSource as never);
    renderHook(() => useComposeStream(7, () => {}, {}, "tok-xyz"));
    expect(created[0]).toBe(
      "/api/spec-factory/compose/sessions/7/stream?token=tok-xyz",
    );
  });
});
