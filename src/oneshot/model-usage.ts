export type OneShotModelUsage = Record<
  string,
  {
    input: number;
    output: number;
  }
>;

export function mergeModelUsage(
  primary?: OneShotModelUsage,
  secondary?: OneShotModelUsage,
): OneShotModelUsage | undefined {
  if (!primary && !secondary) {
    return undefined;
  }

  const merged: OneShotModelUsage = {};
  for (const usage of [primary, secondary]) {
    if (!usage) continue;
    for (const [model, tokens] of Object.entries(usage)) {
      const existing = merged[model] ?? { input: 0, output: 0 };
      existing.input += Math.max(tokens.input ?? 0, 0);
      existing.output += Math.max(tokens.output ?? 0, 0);
      merged[model] = existing;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}
