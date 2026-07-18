import { describe, expect, it } from "vitest";
import {
  buildMhkOrganizationalContext,
  buildMhkOrganizationalContextPrefix,
  buildMhkRelevantOrganizationalContext,
  getMhkOrganizationalContextMetadata,
  loadMhkOrganizationalContext,
  MHK_ORGANIZATIONAL_CONTEXT_VERSION,
  parseMhkOrganizationalContext,
} from "./organizational-context.js";

describe("MHK organizational context", () => {
  it("loads the versioned source and always includes the operating baseline", () => {
    const document = loadMhkOrganizationalContext();
    const context = buildMhkOrganizationalContext("hello");
    const metadata = getMhkOrganizationalContextMetadata(document);

    expect(metadata).toMatchObject({
      version: MHK_ORGANIZATIONAL_CONTEXT_VERSION,
      evidenceSnapshot: "2026-07-13",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(metadata.bytes).toBeGreaterThan(100_000);
    expect(context).toContain("## 0. Agent operating contract");
    expect(context).toContain("## 1. Sixty-second MHK mental model");
    expect(context).toContain("## 2. Canonical identity and alias map");
    expect(context).not.toContain("## 13. MarketProminence deep dive\n");
    expect(context).not.toContain(
      "## Detailed sections retrieved for this conversation turn",
    );
  });

  it("retrieves PBM and pharmacy detail for an ePA conversation", () => {
    const context = buildMhkOrganizationalContext(
      "How does the PBM electronic prior authorization and ePA flow work?",
    );

    expect(context).toContain(
      "## 5. PBMs, pharmacy ePA, portals, InterQual, and MCG",
    );
  });

  it("separates the stable cacheable prefix from turn-specific retrieval", () => {
    const prefix = buildMhkOrganizationalContextPrefix();
    const relevant = buildMhkRelevantOrganizationalContext(
      "How does PBM electronic prior authorization work?",
      { maxRelevantSections: 1 },
    );

    expect(prefix).toContain("## 3. Product and business-domain model");
    expect(prefix).toContain("## 16. Repository atlas");
    expect(prefix).not.toContain("## 5. PBMs, pharmacy ePA");
    expect(prefix.length).toBeGreaterThan(16_384);
    expect(relevant).toContain("## 5. PBMs, pharmacy ePA");
    expect(relevant).not.toContain("## 0. Agent operating contract");
  });

  it("retrieves the separate MarketProminence estate when relevant", () => {
    const context = buildMhkOrganizationalContext(
      "We need Medicare enrollment and premium billing in MarketProminence",
    );

    expect(context).toContain("## 13. MarketProminence deep dive");
  });

  it("bounds detailed retrieval while retaining the complete workspace source", () => {
    const context = buildMhkOrganizationalContext(
      "CareProminence Core App MedicalMgmt Spring Hibernate workflow",
      { maxRelevantChars: 800, maxRelevantSections: 1 },
    );

    expect(context).toContain("## 6. CareProminence Core App deep dive");
    expect(context).toContain(
      "Section truncated to the configured prompt budget",
    );
    expect(loadMhkOrganizationalContext()).toContain(
      "## 18. Evidence and retrieval index",
    );
  });

  it("parses the preamble and all numbered sections deterministically", () => {
    const sections = parseMhkOrganizationalContext(
      loadMhkOrganizationalContext(),
    );

    expect(sections[0]).toMatchObject({
      number: null,
      heading: "Document identity",
    });
    expect(sections.filter((section) => section.number !== null)).toHaveLength(
      19,
    );
    expect(sections.at(-1)?.number).toBe("18");
  });
});
