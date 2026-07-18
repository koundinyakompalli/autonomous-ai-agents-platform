import { describe, expect, it } from "vitest";
import {
  extractMarkdownTemplateSections,
  findDuplicateTemplateHeadings,
  findTemplatePlaceholders,
  LocalDocumentationTemplateProvider,
  validateDocumentationTemplateSnapshot,
} from "./templates.js";

describe("documentation template provider", () => {
  it("loads the Confluence-derived catalog with all supported templates", async () => {
    const provider = new LocalDocumentationTemplateProvider();

    const catalog = await provider.loadCatalog();

    expect(catalog.matrixSource.pageId).toBe("3044573405");
    expect(catalog.matrixSource.version).toBe(20);
    expect(catalog.templates).toHaveLength(9);
    expect(
      catalog.templates.map((template) => template.documentTypeLabel),
    ).toEqual([
      "DOC-TYPE-RELEASE-NOTES",
      "DOC-TYPE-FUNCTIONALITY",
      "DOC-TYPE-INTEGRATION",
      "DOC-TYPE-CONFIG",
      "DOC-TYPE-API",
      "DOC-TYPE-DEPLOYMENT-RUNBOOK",
      "DOC-TYPE-TERRAFORM",
      "DOC-TYPE-TROUBLESHOOTING",
      "DOC-TYPE-SUPPORT-RUNBOOK",
    ]);
  });

  it("loads and validates a normalized template snapshot by document type label", async () => {
    const provider = new LocalDocumentationTemplateProvider();

    const snapshot = await provider.getTemplateByLabel("DOC-TYPE-CONFIG");
    const validation = provider.validateSnapshot(snapshot);

    expect(snapshot.definition.key).toBe("configuration");
    expect(snapshot.definition.confluencePageId).toBe("3117482062");
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sections.map((section) => section.heading)).toContain(
      "What It Affects",
    );
    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredHeadings).toEqual([]);
    expect(validation.placeholders).toEqual([
      "[Screenshot placeholder: configuration section in its most typical state. Source from master environment and remove client data.]",
    ]);
  });

  it("maps supported legacy labels to canonical template labels", async () => {
    const provider = new LocalDocumentationTemplateProvider();

    const snapshot = await provider.getTemplateByLabel("DOC-TYPE-CLIENT-KB");

    expect(snapshot.definition.documentTypeLabel).toBe(
      "DOC-TYPE-FUNCTIONALITY",
    );
  });

  it("marks internal templates with the required internal-use heading", async () => {
    const provider = new LocalDocumentationTemplateProvider();

    const snapshot = await provider.getTemplateByLabel("DOC-TYPE-INTEGRATION");

    expect(snapshot.definition.internalUse).toBe(true);
    expect(snapshot.sections.map((section) => section.heading)).toContain(
      "Internal Use Only",
    );
    expect(provider.validateSnapshot(snapshot).valid).toBe(true);
  });

  it("detects duplicated headings from raw Confluence-style examples", () => {
    const markdown = [
      "# Functionality Article Template",
      "## Overview",
      "Template instructions.",
      "## Screenshot",
      "Placeholder.",
      "## Example",
      "## Overview",
      "Example content.",
    ].join("\n");

    expect(findDuplicateTemplateHeadings(markdown)).toEqual(["Overview"]);
  });

  it("treats duplicated required headings as invalid snapshots", () => {
    const markdown = [
      "# Configuration Article Template",
      "## Overview",
      "First overview.",
      "## What It Affects",
      "Fields.",
      "## Screenshot",
      "Screenshot.",
      "## Overview",
      "Duplicate overview.",
    ].join("\n");

    const validation = validateDocumentationTemplateSnapshot({
      definition: {
        key: "configuration",
        documentTypeLabel: "DOC-TYPE-CONFIG",
        sourceMatrixTask: "Configuration Documentation",
        templateTitle: "Configuration Article Template",
        templateFile: "templates/configuration.md",
        confluencePageId: "3117482062",
        confluenceVersion: 2,
        doc360Target: "External-general configuration article",
        targetAudience: "Client administrators",
        writer: "Development / Product Owner",
        signOff: "Product Owner",
        publishesToDoc360: "Tech Writer",
        requiredRule: "Required for admin screens",
        internalUse: false,
        requiredHeadings: ["Overview", "What It Affects", "Screenshot"],
      },
      markdown,
      placeholders: findTemplatePlaceholders(markdown),
    });

    expect(validation).toMatchObject({
      valid: false,
      missingRequiredHeadings: [],
      duplicateHeadings: ["Overview"],
    });
  });

  it("reports missing required headings deterministically", () => {
    const markdown = "# Configuration Article Template\n\n## Overview\n";
    const validation = validateDocumentationTemplateSnapshot({
      definition: {
        key: "configuration",
        documentTypeLabel: "DOC-TYPE-CONFIG",
        sourceMatrixTask: "Configuration Documentation",
        templateTitle: "Configuration Article Template",
        templateFile: "templates/configuration.md",
        confluencePageId: "3117482062",
        confluenceVersion: 2,
        doc360Target: "External-general configuration article",
        targetAudience: "Client administrators",
        writer: "Development / Product Owner",
        signOff: "Product Owner",
        publishesToDoc360: "Tech Writer",
        requiredRule: "Required for admin screens",
        internalUse: false,
        requiredHeadings: ["Overview", "What It Affects", "Screenshot"],
      },
      markdown,
      placeholders: findTemplatePlaceholders(markdown),
    });

    expect(validation).toMatchObject({
      valid: false,
      missingRequiredHeadings: ["What It Affects", "Screenshot"],
      duplicateHeadings: [],
    });
  });

  it("rejects unknown document type labels", async () => {
    const provider = new LocalDocumentationTemplateProvider();

    await expect(
      provider.getTemplateByLabel("DOC-TYPE-UNKNOWN"),
    ).rejects.toThrow(
      "Unsupported documentation document type label: DOC-TYPE-UNKNOWN",
    );
  });

  it("extracts heading line numbers and stable slugs", () => {
    const sections = extractMarkdownTemplateSections(
      "# API Documentation Article Template\n\n## How It Works\n\n### What the caller sends\n",
    );

    expect(sections).toEqual([
      {
        level: 1,
        heading: "API Documentation Article Template",
        slug: "api-documentation-article-template",
        line: 1,
      },
      {
        level: 2,
        heading: "How It Works",
        slug: "how-it-works",
        line: 3,
      },
      {
        level: 3,
        heading: "What the caller sends",
        slug: "what-the-caller-sends",
        line: 5,
      },
    ]);
  });
});
