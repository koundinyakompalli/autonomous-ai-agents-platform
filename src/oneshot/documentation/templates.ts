import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import {
  DOCUMENTATION_DOCUMENT_TYPE_LABELS,
  normalizeDocumentationDocumentTypeLabel,
  type DocumentationDocumentTypeLabel,
} from "../contracts.js";

export interface DocumentationTemplateMatrixSource {
  title: string;
  spaceKey: string;
  pageId: string;
  version: number;
  url: string;
}

export interface DocumentationTemplateDefinition {
  key: string;
  documentTypeLabel: DocumentationDocumentTypeLabel;
  sourceMatrixTask: string;
  templateTitle: string;
  templateFile: string;
  confluencePageId: string;
  confluenceVersion: number;
  doc360Target: string;
  targetAudience: string;
  writer: string;
  signOff: string;
  publishesToDoc360: string;
  requiredRule: string;
  internalUse: boolean;
  requiredHeadings: string[];
}

export interface DocumentationTemplateCatalog {
  schemaVersion: number;
  reviewedAt: string;
  matrixSource: DocumentationTemplateMatrixSource;
  templates: DocumentationTemplateDefinition[];
}

export interface DocumentationTemplateSection {
  level: number;
  heading: string;
  slug: string;
  line: number;
}

export interface DocumentationTemplateSnapshot {
  definition: DocumentationTemplateDefinition;
  markdown: string;
  contentHash: string;
  sections: DocumentationTemplateSection[];
  placeholders: string[];
}

export interface DocumentationTemplateValidation {
  valid: boolean;
  missingRequiredHeadings: string[];
  duplicateHeadings: string[];
  placeholders: string[];
}

export interface LocalDocumentationTemplateProviderOptions {
  basePath?: string;
}

const DOCUMENT_TYPE_LABELS =
  DOCUMENTATION_DOCUMENT_TYPE_LABELS as readonly string[];

const TemplateDefinitionSchema = z.object({
  key: z.string().min(1),
  documentTypeLabel: z
    .string()
    .refine(
      (value) => DOCUMENT_TYPE_LABELS.includes(value),
      "documentTypeLabel must be a supported DOC-TYPE label",
    ),
  sourceMatrixTask: z.string().min(1),
  templateTitle: z.string().min(1),
  templateFile: z.string().min(1),
  confluencePageId: z.string().min(1),
  confluenceVersion: z.number().int().positive(),
  doc360Target: z.string().min(1),
  targetAudience: z.string().min(1),
  writer: z.string().min(1),
  signOff: z.string().min(1),
  publishesToDoc360: z.string().min(1),
  requiredRule: z.string().min(1),
  internalUse: z.boolean(),
  requiredHeadings: z.array(z.string().min(1)).min(1),
});

const TemplateCatalogSchema = z.object({
  schemaVersion: z.number().int().positive(),
  reviewedAt: z.string().min(1),
  matrixSource: z.object({
    title: z.string().min(1),
    spaceKey: z.string().min(1),
    pageId: z.string().min(1),
    version: z.number().int().positive(),
    url: z.string().url(),
  }),
  templates: z.array(TemplateDefinitionSchema).min(1),
});

export function defaultDocumentationTemplateBasePath(): string {
  return path.resolve(
    process.cwd(),
    "oneshot-prompts",
    "documentation-templates",
  );
}

export function hashDocumentationTemplateContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function normalizeTemplateHeading(heading: string): string {
  return heading
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function slugifyTemplateHeading(heading: string): string {
  return normalizeTemplateHeading(heading)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractMarkdownTemplateSections(
  markdown: string,
): DocumentationTemplateSection[] {
  const sections: DocumentationTemplateSection[] = [];
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      return;
    }

    const heading = match[2].trim();
    sections.push({
      level: match[1].length,
      heading,
      slug: slugifyTemplateHeading(heading),
      line: index + 1,
    });
  });

  return sections;
}

export function findDuplicateTemplateHeadings(markdown: string): string[] {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();

  for (const section of extractMarkdownTemplateSections(markdown)) {
    const normalized = normalizeTemplateHeading(section.heading);
    const first = seen.get(normalized);
    if (first) {
      duplicates.add(first);
    } else {
      seen.set(normalized, section.heading);
    }
  }

  return [...duplicates].sort((a, b) => a.localeCompare(b));
}

export function findTemplatePlaceholders(markdown: string): string[] {
  const placeholders = new Set<string>();
  const bracketPattern =
    /\[[^\]\n]*(?:placeholder|not found|screenshot)[^\]\n]*\]/gi;
  const anglePattern = /<[^>\n]*(?:not found|value|todo|placeholder)[^>\n]*>/gi;

  for (const match of markdown.matchAll(bracketPattern)) {
    placeholders.add(match[0].trim());
  }
  for (const match of markdown.matchAll(anglePattern)) {
    placeholders.add(match[0].trim());
  }

  return [...placeholders].sort((a, b) => a.localeCompare(b));
}

export function validateDocumentationTemplateSnapshot(
  snapshot: Pick<
    DocumentationTemplateSnapshot,
    "definition" | "markdown" | "placeholders"
  >,
): DocumentationTemplateValidation {
  const sections = extractMarkdownTemplateSections(snapshot.markdown);
  const sectionHeadings = new Set(
    sections.map((section) => normalizeTemplateHeading(section.heading)),
  );
  const missingRequiredHeadings = snapshot.definition.requiredHeadings.filter(
    (heading) => !sectionHeadings.has(normalizeTemplateHeading(heading)),
  );
  const duplicateHeadings = findDuplicateTemplateHeadings(snapshot.markdown);

  return {
    valid:
      missingRequiredHeadings.length === 0 && duplicateHeadings.length === 0,
    missingRequiredHeadings,
    duplicateHeadings,
    placeholders: snapshot.placeholders,
  };
}

function assertUniqueCatalogEntries(
  catalog: DocumentationTemplateCatalog,
): void {
  const keys = new Set<string>();
  const labels = new Set<string>();

  for (const template of catalog.templates) {
    if (keys.has(template.key)) {
      throw new Error(`Duplicate documentation template key: ${template.key}`);
    }
    if (labels.has(template.documentTypeLabel)) {
      throw new Error(
        `Duplicate documentation template label: ${template.documentTypeLabel}`,
      );
    }
    keys.add(template.key);
    labels.add(template.documentTypeLabel);
  }
}

function parseTemplateCatalog(raw: string): DocumentationTemplateCatalog {
  const parsed = TemplateCatalogSchema.parse(JSON.parse(raw));
  const catalog = parsed as DocumentationTemplateCatalog;
  assertUniqueCatalogEntries(catalog);
  return catalog;
}

export class LocalDocumentationTemplateProvider {
  private readonly basePath: string;
  private catalogCache?: DocumentationTemplateCatalog;

  constructor(options: LocalDocumentationTemplateProviderOptions = {}) {
    this.basePath = options.basePath ?? defaultDocumentationTemplateBasePath();
  }

  async loadCatalog(): Promise<DocumentationTemplateCatalog> {
    if (this.catalogCache) {
      return this.catalogCache;
    }

    const catalogPath = path.resolve(this.basePath, "catalog.json");
    const raw = await fs.readFile(catalogPath, "utf8");
    this.catalogCache = parseTemplateCatalog(raw);
    return this.catalogCache;
  }

  async getTemplateByLabel(
    label: DocumentationDocumentTypeLabel | string,
  ): Promise<DocumentationTemplateSnapshot> {
    const canonical = normalizeDocumentationDocumentTypeLabel(label);
    if (!canonical || canonical === "ambiguous") {
      throw new Error(
        `Unsupported documentation document type label: ${label}`,
      );
    }

    const catalog = await this.loadCatalog();
    const definition = catalog.templates.find(
      (template) => template.documentTypeLabel === canonical,
    );
    if (!definition) {
      throw new Error(
        `Documentation template not found for label: ${canonical}`,
      );
    }

    return this.loadTemplate(definition);
  }

  async getTemplateByKey(key: string): Promise<DocumentationTemplateSnapshot> {
    const catalog = await this.loadCatalog();
    const definition = catalog.templates.find(
      (template) => template.key === key,
    );
    if (!definition) {
      throw new Error(`Documentation template not found for key: ${key}`);
    }

    return this.loadTemplate(definition);
  }

  validateSnapshot(
    snapshot: DocumentationTemplateSnapshot,
  ): DocumentationTemplateValidation {
    return validateDocumentationTemplateSnapshot(snapshot);
  }

  private async loadTemplate(
    definition: DocumentationTemplateDefinition,
  ): Promise<DocumentationTemplateSnapshot> {
    const templatePath = path.resolve(this.basePath, definition.templateFile);
    const markdown = await fs.readFile(templatePath, "utf8");

    return {
      definition,
      markdown,
      contentHash: hashDocumentationTemplateContent(markdown),
      sections: extractMarkdownTemplateSections(markdown),
      placeholders: findTemplatePlaceholders(markdown),
    };
  }
}
