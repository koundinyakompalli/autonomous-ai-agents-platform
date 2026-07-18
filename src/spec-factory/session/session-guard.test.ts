import { describe, expect, it } from "vitest";
import type { ComposeSessionSummary } from "../compose-types.js";
import {
  SYSTEM_ACTOR,
  actorContextFromSpecFactoryActor,
  assertSessionHandoffAllowed,
  assertSessionMutable,
  assertSessionReadable,
  assertSessionStreamable,
} from "./session-guard.js";

function sessionSummary(
  overrides: Partial<ComposeSessionSummary> = {},
): ComposeSessionSummary {
  return {
    id: 7,
    name: "Billing export",
    createdBy: null,
    createdByDisplay: null,
    status: "draft",
    claudeSessionId: null,
    sourceId: null,
    readiness: null,
    s3Prefix: "compose/7/",
    workspacePath: "/mnt/efs/spec-factory/compose/7",
    sourceCount: 1,
    passwordProtected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("session guards", () => {
  const ownerActor = {
    id: "owner@example.com",
    display: "Owner",
    source: "oidc" as const,
    roles: ["user" as const],
  };
  const otherActor = {
    id: "other@example.com",
    display: "Other",
    source: "oidc" as const,
    roles: ["user" as const],
  };
  const adminActor = {
    id: "admin@example.com",
    display: "Admin",
    source: "oidc" as const,
    roles: ["user" as const, "admin" as const],
  };
  const guards = [
    ["readable", assertSessionReadable],
    ["mutable", assertSessionMutable],
    ["streamable", assertSessionStreamable],
    ["handoff", assertSessionHandoffAllowed],
  ] as const;

  for (const [name, guard] of guards) {
    it(`${name} guard passes non-archived sessions`, () => {
      const session = sessionSummary({ status: "ready" });

      expect(guard(session, 7, SYSTEM_ACTOR)).toBe(session);
    });

    it(`${name} guard hides archived sessions`, () => {
      expect(() =>
        guard(sessionSummary({ status: "archived" }), 7, SYSTEM_ACTOR),
      ).toThrow(/not found/i);
    });

    it(`${name} guard allows the session owner`, () => {
      const session = sessionSummary({ createdBy: ownerActor.id });

      expect(guard(session, 7, ownerActor)).toBe(session);
    });

    it(`${name} guard allows admins`, () => {
      const session = sessionSummary({ createdBy: ownerActor.id });

      expect(guard(session, 7, adminActor)).toBe(session);
    });

    it(`${name} guard allows system workers`, () => {
      const session = sessionSummary({ createdBy: ownerActor.id });

      expect(guard(session, 7, SYSTEM_ACTOR)).toBe(session);
    });

    it(`${name} guard hides sessions from non-owners`, () => {
      expect(() =>
        guard(sessionSummary({ createdBy: ownerActor.id }), 7, otherActor),
      ).toThrow(/not found/i);
    });

    it(`${name} guard preserves legacy sessions without an owner`, () => {
      const session = sessionSummary({ createdBy: null });

      expect(guard(session, 7, otherActor)).toBe(session);
    });
  }

  it("maps the default route actor to a system actor", () => {
    expect(
      actorContextFromSpecFactoryActor({
        id: "spec-factory-operator",
        display: "spec-factory-operator",
      }),
    ).toEqual({
      id: "spec-factory-operator",
      display: "spec-factory-operator",
      source: "system",
      roles: ["user"],
    });
  });

  it("maps request actors to oidc users when not in the admin allowlist", () => {
    expect(
      actorContextFromSpecFactoryActor(
        { id: "kompallik", display: "Koundinya" },
        "admin@example.com",
      ),
    ).toEqual({
      id: "kompallik",
      display: "Koundinya",
      source: "oidc",
      roles: ["user"],
    });
  });

  it("adds admin role for actors in the explicit allowlist", () => {
    expect(
      actorContextFromSpecFactoryActor(
        { id: "kompallik", display: "Koundinya" },
        "admin@example.com, kompallik",
      ),
    ).toEqual({
      id: "kompallik",
      display: "Koundinya",
      source: "oidc",
      roles: ["user", "admin"],
    });
  });
});
