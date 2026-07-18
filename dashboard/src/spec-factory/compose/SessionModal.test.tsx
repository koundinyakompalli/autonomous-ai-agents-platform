// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionModal } from "./SessionModal.js";

const cssPath = existsSync(
  "dashboard/src/spec-factory/compose/ComposeExperience.css",
)
  ? "dashboard/src/spec-factory/compose/ComposeExperience.css"
  : "src/spec-factory/compose/ComposeExperience.css";

const legacyCssPath = existsSync(
  "dashboard/src/spec-factory/SpecFactoryPage.css",
)
  ? "dashboard/src/spec-factory/SpecFactoryPage.css"
  : "src/spec-factory/SpecFactoryPage.css";

const sessions = [
  {
    id: 1,
    name: "Billing export",
    status: "draft" as const,
    sourceId: null,
    readiness: null,
    agentPersonaName: "Bohr",
    lastAction: "note_source_added",
    latestContextVersion: 4,
    contextStatus: "clean" as const,
    sourceCount: 2,
    passwordProtected: false,
    createdAt: "t",
    updatedAt: "t",
  },
  {
    id: 2,
    name: "Secure plan",
    createdBy: "kk",
    createdByDisplay: "Koundinya",
    status: "ready" as const,
    sourceId: null,
    readiness: null,
    agentPersonaName: "Huygens",
    analysisRunning: true,
    latestContextVersion: null,
    contextStatus: "dirty" as const,
    sourceCount: 4,
    passwordProtected: true,
    createdAt: "t",
    updatedAt: "t",
  },
];

function renderModal(
  overrides: Partial<ComponentProps<typeof SessionModal>> = {},
) {
  return render(
    <SessionModal
      sessions={sessions}
      onCreate={vi.fn()}
      onLoad={vi.fn()}
      onDelete={vi.fn()}
      onExport={vi.fn()}
      onImport={vi.fn()}
      {...overrides}
    />,
  );
}

function openSavedSessions() {
  fireEvent.click(screen.getByRole("button", { name: /View all/i }));
}

afterEach(cleanup);

describe("SessionModal", () => {
  it("renders the product-discovery home with recent sessions", () => {
    renderModal();
    expect(
      screen.getByRole("heading", { name: /What would you like to shape/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start new session/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /View all/i })).toBeTruthy();
    expect(screen.getByPlaceholderText(/Find a session/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /About Compose/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Upload session/i })).toBeTruthy();
    expect(screen.getByText("Session #1")).toBeTruthy();
    expect(screen.getByText("Billing export")).toBeTruthy();
  });

  it("filters recent sessions and opens the full saved-session view", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/Find a session/i), {
      target: { value: "secure" },
    });
    expect(screen.getByText("Secure plan")).toBeTruthy();
    expect(screen.queryByText("Billing export")).toBeNull();
    openSavedSessions();
    expect(
      screen.getByRole("heading", { name: /Resume a session/i }),
    ).toBeTruthy();
  });

  it("creates a new session with the entered name", () => {
    const onCreate = vi.fn();
    renderModal({ sessions: [], onCreate });
    fireEvent.click(screen.getByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "My idea" },
    });
    fireEvent.change(screen.getByLabelText(/Your name/i), {
      target: { value: "kk" },
    });
    fireEvent.change(screen.getByLabelText(/Session password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    expect(onCreate).toHaveBeenCalledWith({
      name: "My idea",
      userName: "kk",
      password: "secret",
    });
  });

  it("disables create when the name is blank", () => {
    renderModal({ sessions: [] });
    fireEvent.click(screen.getByRole("button", { name: /New Session/i }));
    expect(
      (
        screen.getByRole("button", {
          name: /Create session/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("lists existing sessions and loads one", () => {
    const onLoad = vi.fn();
    renderModal({ onLoad });
    openSavedSessions();
    expect(screen.getByRole("img", { name: "No password" })).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Password protected" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Draft · 2 sources · Bohr/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/In progress · 4 sources · Huygens/i),
    ).toBeTruthy();
    expect(screen.getByText(/Session #1 ·/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /View Secure plan/i })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Resume Billing export/i }),
    );
    expect(onLoad).toHaveBeenCalledWith(1, undefined);
  });

  it("filters saved sessions by status and agent", () => {
    renderModal();
    openSavedSessions();

    fireEvent.change(screen.getByLabelText(/Filter sessions by status/i), {
      target: { value: "ready" },
    });
    expect(screen.getByRole("button", { name: /View Secure plan/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View Billing export/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Filter sessions by status/i), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText(/Filter sessions by agent/i), {
      target: { value: "Bohr" },
    });
    expect(screen.getByRole("button", { name: /View Billing export/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View Secure plan/i })).toBeNull();
  });

  it("prompts for a password when loading a protected session", () => {
    const onLoad = vi.fn();
    renderModal({ onLoad });
    openSavedSessions();
    fireEvent.click(screen.getByRole("button", { name: /View Secure plan/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Resume Secure plan/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /Resume protected session/i }),
    ).toBeTruthy();
    expect(screen.getByText("Welcome back, Koundinya")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Session password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Resume session/i }));
    expect(onLoad).toHaveBeenCalledWith(2, "secret");
  });

  it("keeps the protected-session password prompt open while typing", () => {
    renderModal();
    openSavedSessions();
    fireEvent.click(screen.getByRole("button", { name: /View Secure plan/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Resume Secure plan/i }),
    );

    fireEvent.keyDown(window, { key: "s" });

    expect(
      screen.getByRole("dialog", { name: /Resume protected session/i }),
    ).toBeTruthy();
  });

  it("deletes unprotected sessions without a password", () => {
    const onDelete = vi.fn();
    renderModal({ onDelete });
    openSavedSessions();
    fireEvent.click(
      screen.getByRole("button", { name: /Delete Billing export/i }),
    );
    expect(onDelete).toHaveBeenCalledWith(1, undefined);
  });

  it("prompts for a password when deleting a protected session", () => {
    const onDelete = vi.fn();
    renderModal({ onDelete });
    openSavedSessions();
    fireEvent.click(screen.getByRole("button", { name: /View Secure plan/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Delete Secure plan/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /Delete protected session/i }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Session password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Delete session/i }));
    expect(onDelete).toHaveBeenCalledWith(2, "secret");
  });

  it("exports sessions and prompts for protected export passwords", () => {
    const onExport = vi.fn();
    renderModal({ onExport });
    openSavedSessions();
    fireEvent.click(
      screen.getByRole("button", { name: /Export Billing export/i }),
    );
    expect(onExport).toHaveBeenCalledWith(1, undefined);

    fireEvent.click(screen.getByRole("button", { name: /View Secure plan/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Export Secure plan/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /Export protected session/i }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Session password/i), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Export session/i }));
    expect(onExport).toHaveBeenCalledWith(2, "secret");
  });

  it("shows About and imports a selected session bundle", () => {
    const onImport = vi.fn();
    renderModal({ onImport });
    fireEvent.click(screen.getByRole("button", { name: /About/i }));
    expect(screen.getByText(/gathers files/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    fireEvent.click(screen.getByRole("button", { name: /Upload Session/i }));
    const button = screen.getByRole("button", {
      name: /Import session/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const file = new File(["{}"], "compose-session.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByLabelText(/Session bundle/i), {
      target: { files: [file] },
    });
    expect(screen.getByText("compose-session.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Import session/i }));
    expect(onImport).toHaveBeenCalledWith(file);
  });

  it("uses a workspace-scoped backdrop that does not cover the side-nav", () => {
    const { container } = renderModal({ sessions: [] });
    // scoped backdrop is absolute within the workspace column, never the global fixed full-viewport one
    const scoped = container.querySelector(".sf-compose-modal-backdrop");
    expect(scoped).not.toBeNull();
    expect(container.querySelector(".sf-modal-backdrop")).toBeNull();
  });

  it("shows session errors inside the modal", () => {
    renderModal({
      sessions: [],
      errorMessage: "Invalid password for Compose session 7",
    });
    expect(screen.getByRole("alert").textContent).toContain("Invalid password");
  });

  it("uses the split saved-session list and detail layout", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-sessions-body\s*\{[^}]*grid-template-columns:\s*58%\s+42%/s,
    );
    expect(css).toMatch(
      /\.sf-compose-sessions-list\s+button\s*\{[^}]*min-height:\s*71px/s,
    );
    expect(css).toMatch(
      /\.sf-compose-sessions-footer\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr\s+1fr/s,
    );
  });

  it("keeps saved-session titles compact on one line", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-sessions-list\s+strong,\s*\.sf-compose-sessions-list\s+small\s*\{[^}]*text-overflow:\s*ellipsis/s,
    );
    expect(css).toMatch(
      /\.sf-compose-sessions-list\s+strong,\s*\.sf-compose-sessions-list\s+small\s*\{[^}]*white-space:\s*nowrap/s,
    );
  });

  it("keeps the saved-session Back to start action compact", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-session-modal\.is-sessions\s+\.sf-compose-modal-brand\s*>\s*button\s*\{[^}]*min-height:\s*34px/s,
    );
  });

  it("uses a clear primary resume action and status treatments", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-session-resume\s*\{[^}]*background:\s*var\(--sfx-purple\)/s,
    );
    expect(css).toMatch(
      /\.sf-compose-sessions-list\s+b\.is-ready,[^{]+\{[^}]*background:\s*#e5f6f3/s,
    );
  });

  it("keeps protected-session password actions sleek", () => {
    const css = readFileSync(legacyCssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-password-popover\s+\.sf-compose-modal-actions\s+button\s*\{[^}]*min-height:\s*38px/s,
    );
    expect(css).toMatch(
      /\.sf-compose-password-popover\s+\.sf-compose-modal-actions\s+button\s*\{[^}]*border-radius:\s*999px/s,
    );
  });

  it("keeps protected-session password text readable on the light popover", () => {
    const css = readFileSync(legacyCssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-password-popover\s+\.sf-compose-modal-title\s+h2\s*\{[^}]*color:\s*#27233c/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-password-popover\s+\.sf-compose-modal-title\s+p\s*\{[^}]*color:\s*#4f5570/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-password-popover\s+\.sf-compose-password-greeting\s*\{[^}]*color:\s*#6251ac/s,
    );
  });
});
