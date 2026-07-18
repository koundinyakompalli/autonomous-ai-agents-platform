export function parseBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(value)) {
    return false;
  }
  throw new Error(
    `${name} must be a boolean value (true/false), got ${JSON.stringify(raw)}`,
  );
}

export function parseJiraPollingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBooleanEnv(env, "JIRA_POLLING_ENABLED", env.NODE_ENV === "production");
}
