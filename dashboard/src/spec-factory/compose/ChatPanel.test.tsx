// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { ChatPanel } from "./ChatPanel.js";
import type { ComposeChatMessage } from "./composeTypes.js";

const cssPath = existsSync("dashboard/src/spec-factory/SpecFactoryPage.css")
  ? "dashboard/src/spec-factory/SpecFactoryPage.css"
  : "src/spec-factory/SpecFactoryPage.css";
const experienceCssPath = existsSync(
  "dashboard/src/spec-factory/compose/ComposeExperience.css",
)
  ? "dashboard/src/spec-factory/compose/ComposeExperience.css"
  : "src/spec-factory/compose/ComposeExperience.css";

afterEach(() => {
  cleanup();
});

const messages: ComposeChatMessage[] = [
  {
    id: 1,
    sessionId: 7,
    role: "assistant",
    content: "Which repository is this for?",
    createdAt: "t",
  },
  {
    id: 2,
    sessionId: 7,
    role: "user",
    content: "billing-service",
    createdAt: "t",
  },
];

describe("ChatPanel", () => {
  it("renders messages by role", () => {
    render(<ChatPanel messages={messages} onSend={vi.fn()} thinking={false} />);
    expect(screen.getByText("Which repository is this for?")).toBeTruthy();
    expect(screen.getByText("billing-service")).toBeTruthy();
    expect(screen.getByRole("article", { name: /Mendel reply/i })).toBeTruthy();
    expect(screen.getByRole("article", { name: /User reply/i })).toBeTruthy();
  });

  it("keeps formatted user messages readable on the light lavender bubble", () => {
    const css = readFileSync(experienceCssPath, "utf8");

    expect(css).toMatch(
      /\.sf-chat-msg\.is-user,\s*\.sf-chat-msg\.is-user\s+\.sf-formatted-text,\s*\.sf-chat-msg\.is-user\s+\.sf-formatted-text\s+\*\s*\{[^}]*color:\s*#352c66/s,
    );
    expect(css).toMatch(
      /\.sf-chat-msg\.is-user\s+\.sf-formatted-text\s+code\s*\{[^}]*color:\s*#2f2758/s,
    );
  });

  it("shows a timestamp for each persisted chat turn", () => {
    const { container } = render(
      <ChatPanel
        messages={[
          {
            ...messages[0],
            createdAt: "2026-07-13T13:21:00.000Z",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );

    const timestamp = container.querySelector(
      'time[datetime="2026-07-13T13:21:00.000Z"]',
    );
    expect(timestamp).toBeTruthy();
    expect(timestamp?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("uses a stable session-scoped agent name for assistant turns", () => {
    const { rerender } = render(
      <ChatPanel
        sessionId={7}
        messages={[messages[0]]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );

    expect(screen.getByRole("article", { name: /Mendel reply/i })).toBeTruthy();
    expect(screen.getByText("Mendel")).toBeTruthy();
    expect(screen.queryByText("Spec Factory")).toBeNull();

    rerender(
      <ChatPanel
        sessionId={8}
        messages={[messages[0]]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );

    expect(screen.getByRole("article", { name: /Fermat reply/i })).toBeTruthy();
    expect(screen.getByText("Fermat")).toBeTruthy();
    expect(screen.queryByText("Mendel")).toBeNull();
  });

  it("prefers the persisted session persona name over the derived fallback", () => {
    render(
      <ChatPanel
        sessionId={7}
        agentPersonaName="Huygens"
        messages={[messages[0]]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );

    expect(
      screen.getByRole("article", { name: /Huygens reply/i }),
    ).toBeTruthy();
    expect(screen.getByText("Huygens")).toBeTruthy();
    expect(screen.queryByText("Mendel")).toBeNull();
  });

  it("keeps requirement artifacts out of the chat viewport", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        ideating="Shaping a CSV export epic."
        problem="Operators cannot export billing data."
      />,
    );
    expect(screen.queryByLabelText(/Context summary/i)).toBeNull();
    expect(
      screen.queryByText("Operators cannot export billing data."),
    ).toBeNull();
    expect(screen.queryByText("Shaping a CSV export epic.")).toBeNull();
    expect(screen.getByLabelText("Compose conversation")).toBeTruthy();
  });

  it("does not render a legacy solution summary when only ideating is present", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        ideating="Only the approach is known."
      />,
    );
    expect(screen.queryByLabelText(/Context summary/i)).toBeNull();
    expect(screen.queryByText("Only the approach is known.")).toBeNull();
  });

  it("keeps the chat dock compact before context exists", () => {
    const { container } = render(
      <ChatPanel messages={[]} onSend={vi.fn()} thinking={true} />,
    );
    expect(
      container.querySelector(".sf-chat-panel.has-context-summary"),
    ).toBeNull();

    const css = readFileSync(cssPath, "utf8");
    // The panel lays its children out as a flex COLUMN (not a positional
    // grid). This is robust to optional stacked children — the pop-out
    // toolbar, the context summary, and the A/B/C options can appear or not
    // without shifting row tracks (the regression that put the context
    // summary behind the chat). Only the window flexes/scrolls.
    expect(css).toMatch(
      /\.sf-chat-panel\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s,
    );
    expect(css).toMatch(
      /\.sf-chat-panel\s+\.sf-chat-window\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/s,
    );
  });

  it("keeps the context summary out of the chat scroll area when popped out", () => {
    // Regression guard: the pop-out toolbar is an extra child of
    // .sf-chat-panel. With a positional grid that shifted the context
    // summary into the window's growth row and overlapped the chat. The
    // panel must NOT rely on a fixed grid-template-rows child order.
    const css = readFileSync(cssPath, "utf8");
    expect(css).not.toMatch(/\.sf-chat-panel\b[^{]*\{[^}]*grid-template-rows/s);
  });

  it("filters implementation questions and starts with a functional clarification", () => {
    render(
      <ChatPanel
        sessionId={7}
        messages={[]}
        onSend={vi.fn()}
        thinking={false}
        ideating="Need repository and scope."
        openQuestions={[
          "Which repository should we reuse?",
          "Which user roles need this export?",
        ]}
      />,
    );

    const question = screen.getByRole("article", {
      name: /Mendel question/i,
    });
    const turn = question.closest(".sf-chat-turn") as HTMLElement;
    expect(within(turn).getByText("Mendel")).toBeTruthy();
    expect(
      within(question).getByText("Which user roles need this export?"),
    ).toBeTruthy();
    expect(screen.queryByText("Which repository should we reuse?")).toBeNull();
  });

  it("does not mistake product terminology for implementation detail", () => {
    render(
      <ChatPanel
        sessionId={7}
        messages={[]}
        onSend={vi.fn()}
        thinking={false}
        openQuestions={["Which payment method should members use?"]}
      />,
    );

    expect(
      screen.getByText("Which payment method should members use?"),
    ).toBeTruthy();
  });

  it("does not duplicate the first open question when it is already in chat", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 10,
            sessionId: 7,
            role: "assistant",
            content: "Which user roles need access?",
            createdAt: "t",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
        ideating="Need affected roles."
        openQuestions={["Which user roles need access?"]}
      />,
    );

    expect(screen.getAllByText("Which user roles need access?")).toHaveLength(
      1,
    );
  });

  it("splits question-prefixed user messages into an agent prompt and user answer", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 20,
            sessionId: 7,
            role: "user",
            content: "Which user roles need access?\n\nBilling auditors",
            createdAt: "t",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
        ideating="Need affected roles."
        openQuestions={["Which user roles need access?"]}
      />,
    );

    const question = screen.getByRole("article", {
      name: /Mendel question/i,
    });
    expect(question.closest(".sf-chat-turn")).toBeTruthy();
    expect(
      within(question.closest(".sf-chat-turn") as HTMLElement).getByText(
        "Mendel",
      ),
    ).toBeTruthy();
    expect(
      within(question).getByText("Which user roles need access?"),
    ).toBeTruthy();

    const answer = screen.getByRole("article", { name: /User reply/i });
    const answerTurn = answer.closest(".sf-chat-turn") as HTMLElement;
    expect(within(answerTurn).getByText("You")).toBeTruthy();
    expect(within(answer).getByText("Billing auditors")).toBeTruthy();
    expect(answer.textContent).not.toContain("Which user roles need access?");
  });

  it("shows a persistent clarification-expired affordance near the composer", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        clarificationExpiredMessage="Clarification expired. Send a new message to continue with fresh context."
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Clarification expired");
    expect(alert.textContent).toContain("continue with fresh context");
  });

  it("asks for explicit consent before starting developer research", () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        onSend={vi.fn()}
        thinking={false}
        researchConsentPrompt={{
          problemStatement: "Auditors cannot export billing records.",
          busy: false,
          onApprove,
          onDismiss,
        }}
      />,
    );

    expect(screen.getByText("Problem statement ready")).toBeTruthy();
    expect(
      screen.getByText(
        "May I ask the development agent to research the codebase now?",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Auditors cannot export/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Start code research/i }),
    );
    expect(onApprove).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Not now/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("preserves the initial assistant reply in the chat history", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 10,
            sessionId: 7,
            role: "assistant",
            content:
              "I reviewed the sources and captured the initial requirement.",
            createdAt: "t",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
        ideating="Need affected roles."
        openQuestions={["Which user roles need access?"]}
      />,
    );

    expect(screen.getByText(/captured the initial requirement/i)).toBeTruthy();
    expect(
      screen.getByRole("article", { name: /Mendel question/i }),
    ).toBeTruthy();
  });

  it("formats markdown emphasis and inline code in agent replies", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 30,
            sessionId: 7,
            role: "assistant",
            content:
              "Here's what's still pending — all **design decisions**, none blocking.\n\n**API shape** — New dedicated endpoint, or extend `submitPreAuthDetermined`?\n**FHIR target field** — Use `processNote[].text` by default.",
            createdAt: "t",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );

    const reply = screen.getByRole("article", {
      name: /Mendel reply/i,
    });
    expect(reply.textContent).not.toContain("**");
    expect(within(reply).getByText("design decisions").tagName).toBe("STRONG");
    expect(within(reply).getByText("API shape").tagName).toBe("STRONG");
    expect(within(reply).getByText("submitPreAuthDetermined").tagName).toBe(
      "CODE",
    );
    expect(within(reply).getByText("processNote[].text").tagName).toBe("CODE");
  });

  it("cleans tool wrapper artifacts and keeps endpoint-heavy replies readable", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 31,
            sessionId: 7,
            role: "assistant",
            content:
              "Dug into the web services again and found the purpose-built entry point.\n\n" +
              "- `POST /rest/ProviderDisputesRestServices/submitProviderDisputes` — multipart/form-data taking `WSProviderAppeals` plus `Documents[]`.\n" +
              "  This calls `submitAppeal(WSProviderAppeal, SubmitAction.Create, attachments)`.\n" +
              "- `submitProviderDispute` and `getProviderDisputesPaging` support the View Appeals flow.\n\n" +
              "Highest-value blocker: Should the portal target `ProviderDisputesRestServices/submitProviderDisputes`?\n\n" +
              "</parameter>\n\n</invoke>",
            createdAt: "t",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );

    const reply = screen.getByRole("article", {
      name: /Mendel reply/i,
    });
    expect(reply.textContent).toContain("Dug into the web services");
    expect(reply.textContent).toContain(
      "This calls submitAppeal(WSProviderAppeal, SubmitAction.Create, attachments).",
    );
    expect(reply.textContent).not.toContain("</parameter>");
    expect(reply.textContent).not.toContain("</invoke>");
    expect(
      within(reply).getByText(
        "POST /rest/ProviderDisputesRestServices/submitProviderDisputes",
      ).tagName,
    ).toBe("CODE");
    expect(within(reply).getAllByRole("listitem")).toHaveLength(2);
  });

  it("sends a message and clears the input", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={messages} onSend={onSend} thinking={false} />);
    const input = screen.getByLabelText(/Message/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "It's billing-service" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));
    expect(onSend).toHaveBeenCalledWith("It's billing-service");
    expect(input.value).toBe("");
  });

  it("shows a thinking indicator while the assistant turn is running", () => {
    render(<ChatPanel messages={messages} onSend={vi.fn()} thinking={true} />);
    expect(screen.getByText("Thinking...")).toBeTruthy();
    expect(screen.getAllByText("Mendel").length).toBeGreaterThan(1);
  });

  it("shows streamed progress text in the thinking indicator", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={true}
        progressMessage="Checking repositories"
      />,
    );

    expect(screen.getByText("Checking repositories")).toBeTruthy();
    expect(screen.queryByText("Working on it")).toBeNull();
  });

  it("lets the user send a follow-up while a response is already in flight", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={messages} onSend={onSend} thinking={true} />);
    const input = screen.getByLabelText(/Message/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Another update" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("Another update");
    expect(input.value).toBe("");
  });

  it("does not send a blank message", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={messages} onSend={onSend} thinking={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders the send control as an icon button keyed by aria-label", () => {
    render(<ChatPanel messages={messages} onSend={vi.fn()} thinking={false} />);
    const send = screen.getByRole("button", { name: /Send/i });
    expect(send.querySelector("svg")).toBeTruthy();
    expect(send.textContent?.trim()).toBe("");
  });

  it("shows a distinct retrying indicator with attempt and countdown", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={true}
        retryStatus={{
          attempt: 2,
          maxAttempts: 5,
          nextRetryInSeconds: 4,
          message: "Bedrock throttle",
        }}
      />,
    );

    const indicator = screen.getByRole("status", {
      name: /Retrying/i,
    });
    expect(indicator.className).toMatch(/is-retrying/);
    expect(indicator.textContent).toMatch(/attempt\s*2\s*of\s*5/i);
    expect(indicator.textContent).toMatch(/in\s*4s/i);
    // The generic thinking state should not double up with retry details.
    expect(screen.queryByText("Thinking...")).toBeNull();
  });

  it("renders A/B/C option buttons for the active question and sends the option text", () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={false}
        onSend={onSend}
        activeQuestion={{
          id: "q-1",
          question: "Which roles may export records?",
          options: ["Billing auditors", "Finance users", "Administrators"],
          questionType: "business",
        }}
      />,
    );
    const options = screen.getByRole("group", { name: /Suggested answers/i });
    fireEvent.click(
      within(options).getByRole("button", { name: /Finance users/i }),
    );
    expect(onSend).toHaveBeenCalledWith("Finance users");
    // The options must render OUTSIDE the input pill (.sf-chat-dock), as their
    // own row between the chat window and the dock — not crowding the textarea.
    expect(options.closest(".sf-chat-dock")).toBeNull();
  });

  it("hints the custom-answer path in the input placeholder when options are active", () => {
    const { rerender } = render(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={false}
        onSend={vi.fn()}
        activeQuestion={{
          id: "q-1",
          question: "Which roles may export records?",
          options: ["Billing auditors", "Finance users"],
          questionType: "business",
        }}
      />,
    );
    expect(
      screen.getByPlaceholderText(
        /Pick A\/B\/C above, or type your own answer/i,
      ),
    ).toBeTruthy();

    // No active question with options → the default placeholder.
    rerender(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={false}
        onSend={vi.fn()}
      />,
    );
    expect(
      screen.getByPlaceholderText(
        /Ask a question or describe what you want to achieve/i,
      ),
    ).toBeTruthy();
  });

  it("renders a pop-out control when onPopOut is provided", () => {
    const onPopOut = vi.fn();
    render(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={false}
        onSend={vi.fn()}
        onPopOut={onPopOut}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Pop out chat/i }));
    expect(onPopOut).toHaveBeenCalled();
  });

  it("disables A/B/C option buttons while thinking", () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={true}
        onSend={onSend}
        activeQuestion={{
          id: "q-1",
          question: "Which roles may export records?",
          options: ["Billing auditors", "Finance users"],
          questionType: "business",
        }}
      />,
    );
    const button = screen.getByRole("button", {
      name: /Finance users/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("renders the pop-out control as an icon button with stable aria-labels", () => {
    const onPopOut = vi.fn();
    const { rerender } = render(
      <ChatPanel
        messages={[]}
        onSend={vi.fn()}
        thinking={false}
        onPopOut={onPopOut}
      />,
    );
    const popBtn = screen.getByRole("button", { name: /Pop out chat/i });
    // Icon-only: the visible text is not the words "Pop out"
    expect(popBtn.textContent?.trim()).toBe("");
    expect(popBtn.querySelector("svg")).toBeTruthy();
    fireEvent.click(popBtn);
    expect(onPopOut).toHaveBeenCalled();

    rerender(
      <ChatPanel
        messages={[]}
        onSend={vi.fn()}
        thinking={false}
        onPopOut={onPopOut}
        isPoppedOut
      />,
    );
    const exitBtn = screen.getByRole("button", { name: /Exit full screen/i });
    expect(exitBtn.querySelector("svg")).toBeTruthy();
    expect(exitBtn.textContent?.trim()).toBe("");
  });

  it("keeps the pop-out button floating when requirement artifacts exist", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        problem="A problem."
        onPopOut={vi.fn()}
      />,
    );
    const popBtn = screen.getByRole("button", { name: /Pop out chat/i });
    expect(popBtn.closest(".sf-chat-context-summary")).toBeNull();
    expect(popBtn.classList.contains("sf-chat-popout-floating")).toBe(true);
  });

  it("renders a floating pop-out button when there is no summary yet", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        onPopOut={vi.fn()}
      />,
    );
    const popBtn = screen.getByRole("button", { name: /Pop out chat/i });
    expect(popBtn.closest(".sf-chat-context-summary")).toBeNull();
    expect(popBtn.classList.contains("sf-chat-popout-floating")).toBe(true);
  });

  it("renders the speaker label outside the message bubble", () => {
    render(
      <ChatPanel
        messages={[
          {
            id: 30,
            sessionId: 7,
            role: "user",
            content: "hello there",
            createdAt: "t",
          },
        ]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );
    const bubble = screen.getByRole("article", { name: /User reply/i });
    // speaker label is NOT inside the bubble
    expect(within(bubble).queryByText("You")).toBeNull();
    // it lives on the shared turn wrapper, above the bubble
    const turn = bubble.closest(".sf-chat-turn") as HTMLElement;
    expect(turn).toBeTruthy();
    expect(within(turn).getByText("You")).toBeTruthy();
  });
});
