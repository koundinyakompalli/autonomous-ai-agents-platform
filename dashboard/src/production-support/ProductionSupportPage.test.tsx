// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionSupportPage } from "./ProductionSupportPage.js";

describe("ProductionSupportPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        agents: [
          { id: 1, name: "DARCI", task_type: "DARCI" },
          { id: 2, name: "HERMES", task_type: "HERMES" },
        ],
        tasks: [
          {
            id: 301,
            jira_number: "CPDEV-301",
            status: "in_progress",
            agent_id: 1,
            agent_name: "DARCI",
            customer_name: "CLIENT-A",
            branch: "master",
            source: "jira",
            created_at: "2026-05-16T01:00:00Z",
            updated_at: "2026-05-16T01:05:00Z",
          },
          {
            id: 302,
            jira_number: "CPDEV-302",
            status: "posted_to_jira",
            agent_id: 2,
            agent_name: "HERMES",
            customer_name: "CLIENT-B",
            branch: "release/2026",
            source: "jira",
            created_at: "2026-05-16T00:30:00Z",
            updated_at: "2026-05-16T00:45:00Z",
          },
        ],
      }),
    } as unknown as Response);
  });

  it("renders production support task rows from /api/state", async () => {
    render(<ProductionSupportPage />);

    expect(
      await screen.findByRole("main", { name: "Production Support" }),
    ).toBeTruthy();
    expect(await screen.findByText("CPDEV-301")).toBeTruthy();
    expect(screen.getAllByText("DARCI").length).toBeGreaterThan(0);
    expect(screen.getByText("CLIENT-A")).toBeTruthy();
    expect(screen.getByText("CPDEV-302")).toBeTruthy();
    expect(screen.getAllByText("HERMES").length).toBeGreaterThan(0);
    expect(screen.getByText("2")).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith("/api/state");
  });

  it("links to Product Catalog from the Specter navigation", async () => {
    render(<ProductionSupportPage />);

    expect(
      await screen.findByRole("main", { name: "Production Support" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Product Catalog" }),
    ).toBeTruthy();
  });

  it("links to Spec Factory from the Specter navigation", async () => {
    render(<ProductionSupportPage />);

    expect(
      await screen.findByRole("main", { name: "Production Support" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spec Factory" })).toBeTruthy();
  });
});
