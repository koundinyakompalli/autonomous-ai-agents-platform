// Stub: replaces Electron IPC in the web version.
// api.send is a no-op — layout/seat saves are persisted via localStorage instead.

function noop(..._args: unknown[]): void {}

export const api = {
  send: noop,
  on: (_channel: string, _cb: (...args: unknown[]) => void) => () => {},
  onReplayState: (_cb: (...args: unknown[]) => void) => () => {},
  onReplayEvent: (_cb: (...args: unknown[]) => void) => () => {},
}

// No-op audio unlock for web
export function unlockAudio(): void {}
