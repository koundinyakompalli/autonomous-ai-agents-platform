// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.js";

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("validates a Jira key, shows the confirmation state, and submits the validated payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jiraKey: "CPDEV-123",
          title: "Fix the run queue",
          statusName: "In Progress",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onCreateRun = vi.fn();

    render(
      <CommandPalette
        open
        mode="request"
        onClose={() => undefined}
        onCreateRun={onCreateRun}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "cpdev-123");
    await user.click(screen.getByRole("button", { name: "validate" }));

    await screen.findByText("Confirm this Jira ticket before adding it to the queue.");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oneshot/run-requests/validate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ jiraKey: "CPDEV-123" }),
      }),
    );

    await user.click(screen.getByRole("button", { name: "add to queue" }));

    expect(onCreateRun).toHaveBeenCalledWith({
      jiraKey: "CPDEV-123",
      title: "Fix the run queue",
      statusName: "In Progress",
    });
  });

  it("resets back to input mode when the Jira key changes after validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jiraKey: "CPDEV-123",
            title: "Fix the run queue",
            statusName: "In Progress",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const user = userEvent.setup();

    render(
      <CommandPalette
        open
        mode="request"
        onClose={() => undefined}
        onCreateRun={() => undefined}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "cpdev-123");
    await user.click(screen.getByRole("button", { name: "validate" }));

    await screen.findByText("Confirm this Jira ticket before adding it to the queue.");

    await user.clear(input);
    await user.type(input, "cpdev-124");

    await waitFor(() => {
      expect(
        screen.queryByText("Confirm this Jira ticket before adding it to the queue."),
      ).toBeNull();
    });
    expect(screen.getByRole("button", { name: "validate" })).toBeTruthy();
  });

  it("displays a client_ineligible server error returned from validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Client 'Blocked Corp' is not eligible for OneShot autonomous runs (client_ineligible)",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <CommandPalette
        open
        mode="request"
        onClose={() => undefined}
        onCreateRun={() => undefined}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "cpdev-999");
    await user.click(screen.getByRole("button", { name: "validate" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "validate" }),
      ).toBeTruthy();
    });
    // The error text is displayed in the palette
    const errorText = screen.queryByText(/client_ineligible/i);
    // Error must be visible (either directly or via the error div)
    expect(
      errorText ?? screen.queryByText(/not eligible/i),
    ).toBeTruthy();
  });

  it("uses synthetic validation in mock mode without calling Jira", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onCreateRun = vi.fn();

    render(
      <CommandPalette
        open
        mode="mock"
        onClose={() => undefined}
        onCreateRun={onCreateRun}
      />,
    );

    await user.type(screen.getByRole("textbox"), "cpdev-99");
    await user.click(screen.getByRole("button", { name: "validate" }));

    await screen.findByText("Confirm local mock run creation.");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent === "title: Mock run for CPDEV-99",
      ),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "create mock run" }));

    expect(onCreateRun).toHaveBeenCalledWith({
      jiraKey: "CPDEV-99",
      title: "Mock run for CPDEV-99",
      statusName: "Local mock",
    });
  });
});
