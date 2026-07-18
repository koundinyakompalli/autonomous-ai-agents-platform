import { describe, expect, it } from "vitest";
import { parseJiraPollingEnabled } from "./runtime-config.js";

describe("parseJiraPollingEnabled", () => {
  it("defaults to enabled in production when unset or blank", () => {
    expect(parseJiraPollingEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(
      parseJiraPollingEnabled({
        NODE_ENV: "production",
        JIRA_POLLING_ENABLED: " ",
      }),
    ).toBe(true);
  });

  it("defaults to disabled outside production when unset", () => {
    expect(parseJiraPollingEnabled({ NODE_ENV: "development" })).toBe(false);
  });

  it("parses explicit boolean values", () => {
    expect(parseJiraPollingEnabled({ JIRA_POLLING_ENABLED: "true" })).toBe(
      true,
    );
    expect(parseJiraPollingEnabled({ JIRA_POLLING_ENABLED: "false" })).toBe(
      false,
    );
    expect(parseJiraPollingEnabled({ JIRA_POLLING_ENABLED: "1" })).toBe(true);
    expect(parseJiraPollingEnabled({ JIRA_POLLING_ENABLED: "0" })).toBe(false);
  });

  it("rejects unrecognized values", () => {
    expect(() =>
      parseJiraPollingEnabled({ JIRA_POLLING_ENABLED: "maybe" }),
    ).toThrow(/must be a boolean/);
  });
});
