// @vitest-environment jsdom

import { cleanup, render, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { About, type AboutPanel } from "./About.js";

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function stubBrowserMotion(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (id: number) => window.clearTimeout(id),
  });
}

function renderPanel(panel: AboutPanel) {
  const wordmarkRef = createRef<HTMLHeadingElement>();
  const result = render(
    <About
      panel={panel}
      wordmarkDestRef={wordmarkRef}
      onExit={vi.fn()}
      onPanelChange={vi.fn()}
    />,
  );
  return { ...result, wordmarkRef };
}

function renderedVisibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script, style").forEach((el) => el.remove());
  return clone.textContent ?? "";
}

describe("About shared Guide hero", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    stubBrowserMotion();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      panel: "features",
      heading: /Ship the work your ticket already defines\./i,
      copy: /OneShot turns a ready Jira ticket/i,
      eyebrow: "OneShot · Autonomous feature delivery",
      actions: ["See the How-to", "Read the Tech Spec"],
    },
    {
      panel: "how-to",
      heading: /Start with a ticket OneShot can trust\./i,
      copy: /Use the templates, check the readiness details/i,
      eyebrow: "How-to · operator guide",
      actions: ["Templates", "Wiz scans", "SonarQube", "Before you run"],
    },
    {
      panel: "tech-spec",
      heading: /The machinery behind OneShot\s*\./i,
      copy: /The stages, queues, providers, artifacts/i,
      eyebrow: "Specification",
      actions: ["Release notes"],
    },
    {
      panel: "changelog",
      heading: /Recent shipping notes\s*\./i,
      copy: /A practical record of what changed for operators/i,
      eyebrow: "Changelog",
      actions: [
        "CHANGELOG.md",
        "Feature reference",
        `Version ${__APP_VERSION__}`,
        "Updated",
      ],
    },
  ] as const)(
    "renders the shared hero and wordmark slot for $panel",
    ({ panel, heading, copy, eyebrow, actions }) => {
      const { container, wordmarkRef } = renderPanel(panel);
      const hero = container.querySelector(".about-guide-hero");

      expect(container.querySelectorAll(".about-guide-hero")).toHaveLength(1);
      expect(hero).toBeTruthy();
      expect(
        hero?.querySelector(".about-guide-masthead .about-guide-eyebrow")
          ?.textContent,
      ).toBe(eyebrow);
      expect(
        within(hero as HTMLElement).getByRole("heading", { name: heading }),
      ).toBeTruthy();
      expect(within(hero as HTMLElement).getByText(copy)).toBeTruthy();

      const wordmark = hero?.querySelector(".about-wordmark-slot");
      expect(wordmark?.getAttribute("aria-label")).toBe("OneShot");
      expect(wordmarkRef.current).toBe(wordmark);
      for (const label of actions) {
        expect(
          within(hero as HTMLElement).queryAllByText(label, { exact: false })
            .length,
        ).toBeGreaterThan(0);
      }
    },
  );

  it("keeps How-to jump links inside the shared hero body", () => {
    const { container } = renderPanel("how-to");
    const jumpLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(
        ".about-guide-hero .about-howto-jump-link",
      ),
    );

    expect(jumpLinks.map((link) => link.textContent)).toEqual([
      "Templates",
      "Docs mode",
      "Wiz scans",
      "SonarQube",
      "Wiz Code (SAST)",
      "Before you run",
      "What fits",
      "If it stops",
      "Reference",
    ]);
    expect(jumpLinks.map((link) => link.getAttribute("href"))).toEqual([
      "#about-templates",
      "#about-docs-mode",
      "#about-wiz-scans",
      "#about-sonarqube-scans",
      "#about-wiz-code-scans",
      "#about-before-run",
      "#about-what-fits",
      "#about-if-it-stops",
      "#about-reference",
    ]);
  });

  it("documents Wiz and SonarQube scan-driven OneShot usage", () => {
    const { container } = renderPanel("how-to");
    const text = renderedVisibleText(container);

    expect(text).toContain("WIZ-SCAN-PENDING");
    expect(text).toContain("WIZ-SCAN-APPROVED");
    expect(text).toContain(
      "implementation now records out-of-scope edits as warnings instead of hard-blocking the run",
    );
    expect(text).toContain("SONAR-SCAN-PENDING");
    expect(text).toContain("SONAR-SCAN-APPROVED");
    expect(text).toContain("SONAR-AUTOFIX");
    expect(text).toContain("WIZ-CODE-SCAN-PENDING");
    // Wiz Code auto-applies: no SCAN-APPROVED gate, documented as such.
    expect(text).toContain("no SCAN-APPROVED gate");
    expect(text).toContain("PFOS");
  });

  it("documents documentation mode labels", () => {
    const { container } = renderPanel("how-to");
    const text = renderedVisibleText(container);

    expect(text).toContain("DOCS-GENERATE");
    expect(text).toContain("DOC-TYPE-RELEASE-NOTES");
    expect(text).toContain("DOC-TYPE-FUNCTIONALITY");
    expect(text).toContain("DOC-TYPE-SUPPORT-RUNBOOK");
    expect(text).toContain("DOC-TYPE-CONFIG");
    expect(text).toContain("DOC-TYPE-TROUBLESHOOTING");
    expect(text).toContain("npm run oneshot:docs:dry-run");
    expect(text).toContain("npm run oneshot:docs:run");
    expect(text).toContain("npm run oneshot:docs:run-all");
  });

  it("shows the latest June 2026 OneShot shipping notes", () => {
    const { container } = renderPanel("changelog");
    const text = renderedVisibleText(container);

    expect(text).toContain("QUALIFIER multi-repo decision policy");
    expect(text).toContain("Multi-repo delivery defaulted on");
    expect(text).toContain("Default-branch-first resolution");
    expect(text).toContain("Qualification handoff recovery");
    expect(text).toContain("Planning handoff failure attribution");
  });

  it("classifies scan and documentation artifact work as supported", () => {
    const { container } = renderPanel("how-to");
    const text = renderedVisibleText(container);

    expect(text).toContain("Wiz scan batches");
    expect(text).toContain("SonarQube scan batches");
    expect(text).toContain("Wiz Code (SAST) scan batches");
    expect(text).toContain("Documentation artifact tasks");
    expect(text).toMatch(/24\s*launch checks/);
    expect(text).toMatch(/14\s*supported/);
  });

  it("does not render en or em dashes in any Guide panel copy", () => {
    const panels: AboutPanel[] = [
      "features",
      "how-to",
      "tech-spec",
      "changelog",
    ];

    for (const panel of panels) {
      const { container } = renderPanel(panel);
      expect(renderedVisibleText(container)).not.toMatch(/[—–]/);
      cleanup();
    }
  });
});
