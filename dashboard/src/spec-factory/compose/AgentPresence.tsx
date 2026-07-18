import { MessageCircleMore, UsersRound } from "lucide-react";
import type { ComposeBackgroundAgentState } from "./composeTypes.js";
import {
  friendlyAgentStatus,
  WORKFLOW_PERSONAS,
} from "./personas.js";

export function AgentPresence({
  agents,
  primaryPersonaName,
}: {
  agents: ComposeBackgroundAgentState[];
  primaryPersonaName?: string | null;
}) {
  const activeAgents = agents.filter(
    (agent) => agent.status === "working" || agent.status === "waiting",
  ).length;

  return (
    <section className="sf-agent-presence" aria-label="Agent activity">
      <div className="sf-agent-team-summary">
        <span aria-hidden="true">
          <UsersRound size={17} />
        </span>
        <span>
          <strong>Agent team</strong>
          <small>
            {activeAgents > 0
              ? `${activeAgents} active`
              : `${agents.length} ready`}
          </small>
        </span>
      </div>
      <div className="sf-agent-presence-list">
        {agents.map((agent) => {
          const basePersona = WORKFLOW_PERSONAS[agent.key];
          const persona =
            agent.key === "requirements" && primaryPersonaName?.trim()
              ? { ...basePersona, name: primaryPersonaName.trim() }
              : basePersona;
          const working = agent.status === "working";
          return (
            <div
              key={agent.key}
              className={`sf-agent-persona is-${agent.status}`}
              title={`${persona.name}: ${friendlyAgentStatus(agent)}`}
            >
              <span className="sf-agent-avatar-wrap">
                <img src={persona.avatar} alt="" />
                {working ? (
                  <MessageCircleMore
                    className="sf-agent-thought"
                    size={14}
                    aria-hidden="true"
                  />
                ) : null}
              </span>
              <span className="sf-agent-persona-copy">
                <strong>{persona.name}</strong>
                <small>{persona.role}</small>
                <span className="sf-agent-persona-state">
                  <i aria-hidden="true" />
                  {friendlyAgentStatus(agent)}
                  {working ? <b aria-hidden="true">...</b> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
