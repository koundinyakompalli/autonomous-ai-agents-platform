import type { ComposeSessionSummary } from "../compose-types.js";
import type { SpecFactoryActor } from "../oneshot-submitter.js";

export interface ActorContext {
  id: string;
  display: string;
  source: "oidc" | "system";
  roles: Array<"user" | "admin">;
}

export const SYSTEM_ACTOR: ActorContext = {
  id: "spec-factory-operator",
  display: "spec-factory-operator",
  source: "system",
  roles: ["user"],
};

export function actorContextFromSpecFactoryActor(
  actor: SpecFactoryActor,
  adminIds = process.env.SPEC_FACTORY_ADMIN_IDS ?? "",
): ActorContext {
  const admins = new Set(
    adminIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return {
    id: actor.id,
    display: actor.display,
    source: actor.id === "spec-factory-operator" ? "system" : "oidc",
    roles: admins.has(actor.id) ? ["user", "admin"] : ["user"],
  };
}

export function assertSessionExists(
  session: ComposeSessionSummary | null,
  sessionId: number,
): ComposeSessionSummary {
  if (!session) {
    throw new Error(`Compose session ${sessionId} was not found`);
  }
  return session;
}

export function assertSessionReadable(
  session: ComposeSessionSummary | null,
  sessionId: number,
  actor: ActorContext,
): ComposeSessionSummary {
  const existing = assertSessionExists(session, sessionId);
  if (
    existing.status === "archived" ||
    !actorCanAccessSession(existing, actor)
  ) {
    throw new Error(`Compose session ${sessionId} was not found`);
  }
  return existing;
}

export function assertSessionMutable(
  session: ComposeSessionSummary | null,
  sessionId: number,
  actor: ActorContext,
): ComposeSessionSummary {
  return assertSessionReadable(session, sessionId, actor);
}

export function assertSessionStreamable(
  session: ComposeSessionSummary | null,
  sessionId: number,
  actor: ActorContext,
): ComposeSessionSummary {
  return assertSessionReadable(session, sessionId, actor);
}

export function assertSessionHandoffAllowed(
  session: ComposeSessionSummary | null,
  sessionId: number,
  actor: ActorContext,
): ComposeSessionSummary {
  return assertSessionMutable(session, sessionId, actor);
}

function actorCanAccessSession(
  session: ComposeSessionSummary,
  actor: ActorContext,
): boolean {
  if (actor.source === "system") return true;
  if (actor.roles.includes("admin")) return true;
  if (!session.createdBy) return true;
  return session.createdBy === actor.id;
}
