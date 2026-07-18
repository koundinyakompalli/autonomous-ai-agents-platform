import type { createLogger } from "../utils/logger.js";

type Logger = ReturnType<typeof createLogger>;

interface JiraAgentCredentials {
  jira_username?: string | null;
  jira_token?: string | null;
}

export interface OneShotJiraCredentials {
  username: string;
  token: string;
  source: "qualifier_agent" | "configured";
}

interface ResolveOneShotJiraCredentialsInput {
  getAgentByName?: (name: string) => Promise<JiraAgentCredentials | null>;
  fallbackUsername?: string | null;
  fallbackToken?: string | null;
  logger?: Pick<Logger, "warn">;
  warningMessage?: string;
}

export async function resolveOneShotJiraCredentials(
  input: ResolveOneShotJiraCredentialsInput,
): Promise<OneShotJiraCredentials | null> {
  const fallbackUsername = input.fallbackUsername?.trim() ?? "";
  const fallbackToken = input.fallbackToken?.trim() ?? "";

  if (input.getAgentByName) {
    try {
      const qualifierAgent = await input.getAgentByName("QUALIFIER");
      const agentToken = qualifierAgent?.jira_token?.trim();
      if (agentToken) {
        return {
          username: qualifierAgent?.jira_username?.trim() || fallbackUsername,
          token: agentToken,
          source: "qualifier_agent",
        };
      }
    } catch (error) {
      input.logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        input.warningMessage ??
          "Unable to load QUALIFIER Jira credentials; falling back to configured Jira credentials",
      );
    }
  }

  if (!fallbackUsername || !fallbackToken) {
    return null;
  }

  return {
    username: fallbackUsername,
    token: fallbackToken,
    source: "configured",
  };
}
