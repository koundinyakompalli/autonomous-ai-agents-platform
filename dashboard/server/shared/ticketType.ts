export const ONE_SHOT_TICKET_TYPES = [
  "story",
  "defect",
  "sonar",
  "security",
  "retrofit",
  "documentation",
  "other",
  "unknown",
] as const;

export type OneShotTicketType = (typeof ONE_SHOT_TICKET_TYPES)[number];

const TICKET_TYPE_SET = new Set<string>(ONE_SHOT_TICKET_TYPES);

export function normalizeOneShotTicketType(
  value: unknown,
): OneShotTicketType | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TICKET_TYPE_SET.has(normalized)
    ? (normalized as OneShotTicketType)
    : null;
}
