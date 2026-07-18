import { describe, expect, it } from "vitest";
import { resolveOneShotTicketType } from "./ticket-type.js";

describe("resolveOneShotTicketType", () => {
  it("classifies raw Jira stories and defects", () => {
    expect(
      resolveOneShotTicketType({ jiraIssueType: "Story" }).ticketType,
    ).toBe("story");
    expect(
      resolveOneShotTicketType({ jiraIssueType: "Defect" }).ticketType,
    ).toBe("defect");
  });

  it("lets Sonar labels override Jira Story", () => {
    const result = resolveOneShotTicketType({
      jiraIssueType: "Story",
      jiraLabels: ["SONAR-AUTOFIX"],
      ticketSummary: "[SonarQube] java:S1234 - core-app",
    });

    expect(result.ticketType).toBe("sonar");
    expect(result.jiraIssueType).toBe("Story");
    expect(result.ticketTypeSource).toBe("inferred_sonar");
  });

  it("lets Sonar title prefixes override Jira Story without body scanning", () => {
    const result = resolveOneShotTicketType({
      jiraIssueType: "Story",
      ticketSummary: "[SonarQube] java:S1234 - core-app",
      taskDescription: "Implementation notes mention security review only.",
    });

    expect(result.ticketType).toBe("sonar");
    expect(result.ticketTypeSource).toBe("inferred_sonar");
  });

  it("lets Wiz and security signals override Jira Story", () => {
    const result = resolveOneShotTicketType({
      jiraIssueType: "Story",
      jiraLabels: ["WIZ-SCAN-HIGH"],
      ticketSummary: "[Security] log4j - Wiz remediation",
    });

    expect(result.ticketType).toBe("security");
    expect(result.jiraIssueType).toBe("Story");
    expect(result.ticketTypeSource).toBe("inferred_security");
  });

  it("does not classify plain PFOS intake labels as security", () => {
    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Story",
        jiraLabels: ["PFOS"],
        ticketSummary: "Improve intake validation",
      }).ticketType,
    ).toBe("story");

    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Defect",
        jiraLabels: ["PFOS"],
        ticketSummary: "Fix broken intake validation",
      }).ticketType,
    ).toBe("defect");

    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Task",
        jiraLabels: ["PFOS"],
        ticketSummary: "Retrofit completed fix",
      }).ticketType,
    ).toBe("retrofit");
  });

  it("does not infer operational lanes from body-only mentions", () => {
    const result = resolveOneShotTicketType({
      jiraIssueType: "Story",
      ticketSummary: "Improve intake validation",
      taskDescription: "Security review found no concerns. Sonar is unchanged.",
    });

    expect(result.ticketType).toBe("story");
    expect(result.ticketTypeSource).toBe("jira_issue_type");
  });

  it("classifies retrofit title signals before raw Jira type", () => {
    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Story",
        ticketSummary: "Retrofit CPDEV-22361 from 4.0 to master",
      }),
    ).toMatchObject({
      ticketType: "retrofit",
      ticketTypeSource: "inferred_retrofit",
      jiraIssueType: "Story",
    });

    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Task",
        ticketSummary: "Flyway Retro for CPDEV-22962 from master to 3.19",
      }).ticketType,
    ).toBe("retrofit");

    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Sub-task",
        ticketSummary: "Forward-port CPDEV-123 from 3.19 to 4.1",
      }).ticketType,
    ).toBe("retrofit");
  });

  it("keeps Sonar and Wiz/Security precedence above retrofit titles", () => {
    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Story",
        ticketSummary: "[SonarQube] Retrofit rule java:S1234",
      }).ticketType,
    ).toBe("sonar");

    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Story",
        ticketSummary: "[Security] Back-port log4j Wiz remediation",
      }).ticketType,
    ).toBe("security");
  });

  it("uses documentation labels only after operational lane and Jira type checks", () => {
    expect(
      resolveOneShotTicketType({
        jiraIssueType: "Story",
        jiraLabels: ["DOCS-GENERATE"],
      }).ticketType,
    ).toBe("story");

    expect(
      resolveOneShotTicketType({
        jiraLabels: ["DOCS-GENERATE"],
      }).ticketType,
    ).toBe("documentation");
  });

  it("falls back to other or unknown without guessing", () => {
    expect(
      resolveOneShotTicketType({ jiraIssueType: "Task" }).ticketType,
    ).toBe("other");
    expect(resolveOneShotTicketType({}).ticketType).toBe("unknown");
  });
});
