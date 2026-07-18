import { describe, expect, it } from "vitest";

import {
  getAgentDoneLabel,
  getAgentFailedLabel,
  withDoneAndFailedLabelExclusion,
  withDoneLabelExclusion,
} from "./agentDoneLabels.js";

describe("agent done labels", () => {
  it("uses uppercase agent names with a uniform _DONE suffix", () => {
    expect(getAgentDoneLabel("DARCI")).toBe("DARCI_DONE");
    expect(getAgentDoneLabel(" hermes ")).toBe("HERMES_DONE");
    expect(getAgentDoneLabel("BCAT-PLANNER")).toBe("BCAT_PLANNER_DONE");
    expect(getAgentDoneLabel("BC-INTAKE")).toBe("BC_INTAKE_DONE");
  });

  it("uses uppercase agent names with a uniform _FAILED suffix", () => {
    expect(getAgentFailedLabel("DARCI")).toBe("DARCI_FAILED");
    expect(getAgentFailedLabel(" hermes ")).toBe("HERMES_FAILED");
    expect(getAgentFailedLabel("BCAT-PLANNER")).toBe("BCAT_PLANNER_FAILED");
    expect(getAgentFailedLabel("BC-INTAKE")).toBe("BC_INTAKE_FAILED");
  });

  it("does not create done labels for OneShot queue agents", () => {
    expect(getAgentDoneLabel("QUALIFIER")).toBeNull();
    expect(getAgentDoneLabel("PLANNER")).toBeNull();
    expect(getAgentDoneLabel("REVIEWER")).toBeNull();
    expect(getAgentDoneLabel("IMPLEMENTER")).toBeNull();
    expect(getAgentDoneLabel("CODE_REVIEWER")).toBeNull();
    expect(getAgentDoneLabel("TESTER")).toBeNull();
  });

  it("does not create failed labels for OneShot queue agents", () => {
    expect(getAgentFailedLabel("QUALIFIER")).toBeNull();
    expect(getAgentFailedLabel("PLANNER")).toBeNull();
    expect(getAgentFailedLabel("REVIEWER")).toBeNull();
    expect(getAgentFailedLabel("IMPLEMENTER")).toBeNull();
    expect(getAgentFailedLabel("CODE_REVIEWER")).toBeNull();
    expect(getAgentFailedLabel("TESTER")).toBeNull();
  });

  it("adds done-label exclusions before ORDER BY", () => {
    expect(
      withDoneLabelExclusion(
        "labels in (DARCI) ORDER BY updated DESC",
        "DARCI",
      ),
    ).toBe(
      "labels in (DARCI) AND labels not in (DARCI_DONE) ORDER BY updated DESC",
    );
  });

  it("leaves existing done-label exclusions unchanged", () => {
    const jql =
      "labels in (HERMES) AND labels not in (HERMES_DONE) ORDER BY updated DESC";

    expect(withDoneLabelExclusion(jql, "HERMES")).toBe(jql);
  });

  it("adds done and failed label exclusions before ORDER BY", () => {
    expect(
      withDoneAndFailedLabelExclusion(
        "labels in (BEACON) ORDER BY updated DESC",
        "BEACON",
      ),
    ).toBe(
      "labels in (BEACON) AND labels not in (BEACON_DONE, BEACON_FAILED) ORDER BY updated DESC",
    );
  });

  it("leaves existing done and failed label exclusions unchanged", () => {
    const jql =
      "labels in (DARCI) AND labels not in (DARCI_DONE, DARCI_FAILED) ORDER BY updated DESC";

    expect(withDoneAndFailedLabelExclusion(jql, "DARCI")).toBe(jql);
  });
});
