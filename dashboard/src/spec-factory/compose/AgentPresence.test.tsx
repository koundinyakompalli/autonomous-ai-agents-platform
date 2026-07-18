// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { AgentPresence } from "./AgentPresence.js";
import type { ComposeBackgroundAgentState } from "./composeTypes.js";

const agents: ComposeBackgroundAgentState[] = [
  {
    key: "sources",
    label: "Sources",
    status: "idle",
    detail: "Sources are current",
    activeCount: 0,
  },
  {
    key: "requirements",
    label: "Requirements",
    status: "working",
    detail: "Updating the requirements brief",
    activeCount: 1,
  },
  {
    key: "research",
    label: "Research",
    status: "waiting",
    detail: "Waiting for approval",
    activeCount: 0,
  },
  {
    key: "draft",
    label: "Draft",
    status: "attention",
    detail: "A decision is needed",
    activeCount: 0,
  },
];

afterEach(cleanup);

describe("AgentPresence", () => {
  it("shows each persona and the current product-facing status", () => {
    render(<AgentPresence agents={agents} primaryPersonaName="Avicenna" />);

    const activity = screen.getByLabelText("Agent activity");
    expect(within(activity).getByText("Avicenna")).toBeTruthy();
    expect(within(activity).getByText("Curie")).toBeTruthy();
    expect(within(activity).getByText("Turing")).toBeTruthy();
    expect(within(activity).getByText("Ada")).toBeTruthy();
    expect(within(activity).getByText("Thinking")).toBeTruthy();
    expect(within(activity).getByText("Agent team")).toBeTruthy();
    expect(within(activity).getByText("2 active")).toBeTruthy();
  });

  it("does not duplicate visible agent states behind a team-room control", () => {
    render(<AgentPresence agents={agents} />);

    expect(
      screen.queryByRole("button", { name: /View agent activity/i }),
    ).toBeNull();
    expect(
      screen.getAllByText(/Idle|Ready|Thinking|Waiting|Needs attention/),
    ).toHaveLength(4);
  });
});
