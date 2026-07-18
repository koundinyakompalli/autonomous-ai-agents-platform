import type { OneShotTicketType } from "./types.js";

export type TicketTypeFilter = "all" | OneShotTicketType;

export const TICKET_TYPE_OPTIONS: ReadonlyArray<TicketTypeFilter> = [
  "all",
  "story",
  "defect",
  "sonar",
  "security",
  "retrofit",
  "documentation",
  "other",
  "unknown",
];

export function ticketTypeLabel(type: OneShotTicketType): string {
  switch (type) {
    case "story":
      return "Story";
    case "defect":
      return "Defect";
    case "sonar":
      return "Sonar";
    case "security":
      return "Wiz/Security";
    case "retrofit":
      return "Retrofit";
    case "documentation":
      return "Docs";
    case "other":
      return "Other";
    case "unknown":
      return "Unknown";
  }
}
