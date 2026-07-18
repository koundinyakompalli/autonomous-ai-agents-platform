export const SPEC_FACTORY_RUNTIME_MODES = [
  "all-local",
  "api",
  "worker",
  "turn-worker",
  "context-worker",
  "research-worker",
  "conversion-worker",
  "draft-worker",
  "relay-worker",
  "retention-worker",
] as const;

export type SpecFactoryRuntimeMode =
  (typeof SPEC_FACTORY_RUNTIME_MODES)[number];
