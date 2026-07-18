import type { ComposeBackgroundAgentState } from "./composeTypes.js";

export interface ComposePersona {
  name: string;
  role: string;
  avatar: string;
}

export const WORKFLOW_PERSONAS: Record<
  ComposeBackgroundAgentState["key"],
  ComposePersona
> = {
  sources: {
    name: "Curie",
    role: "Sources",
    avatar: "/spec-factory/personas/curie.png",
  },
  requirements: {
    name: "Avicenna",
    role: "Requirements",
    avatar: "/spec-factory/personas/avicenna.png",
  },
  research: {
    name: "Turing",
    role: "Research",
    avatar: "/spec-factory/personas/turing.png",
  },
  draft: {
    name: "Ada",
    role: "Draft",
    avatar: "/spec-factory/personas/ada.png",
  },
};

const CHAT_AVATARS = Object.values(WORKFLOW_PERSONAS).map(
  (persona) => persona.avatar,
);

export function avatarForAgent(name: string): string {
  const normalized = name.trim().toLowerCase();
  const known = Object.values(WORKFLOW_PERSONAS).find(
    (persona) => persona.name.toLowerCase() === normalized,
  );
  if (known) return known.avatar;

  const hash = Array.from(normalized).reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  return CHAT_AVATARS[hash % CHAT_AVATARS.length];
}

export function friendlyAgentStatus(
  agent: ComposeBackgroundAgentState,
): string {
  if (agent.status === "attention") return "Needs attention";
  if (agent.status === "waiting") return "Ready";
  if (agent.status === "idle") return "Idle";
  if (agent.key === "sources") return "Reviewing sources";
  if (agent.key === "requirements") return "Thinking";
  if (agent.key === "research") return "Researching";
  return "Drafting";
}
