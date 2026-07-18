import {
  SpecFactoryDraftBundleSchema,
  type SpecFactoryDraftBundle,
} from "./types.js";
import { normalizeGherkinCriterion } from "./gherkin.js";

interface ValidDraftValidationResult {
  valid: true;
  normalized: SpecFactoryDraftBundle;
  errors: string[];
  warnings: string[];
}

interface InvalidDraftValidationResult {
  valid: false;
  normalized: SpecFactoryDraftBundle | null;
  raw?: unknown;
  errors: string[];
  warnings: string[];
}

export type DraftValidationResult =
  | ValidDraftValidationResult
  | InvalidDraftValidationResult;

function normalizeAcceptanceCriteria(
  bundle: SpecFactoryDraftBundle,
): SpecFactoryDraftBundle {
  return {
    ...bundle,
    epic: {
      ...bundle.epic,
      acceptanceCriteria: bundle.epic.acceptanceCriteria.map(
        (criterion, index) =>
          normalizeGherkinCriterion(criterion, bundle.epic.summary, index),
      ),
    },
    childTickets: bundle.childTickets.map((ticket) => ({
      ...ticket,
      acceptanceCriteria: ticket.acceptanceCriteria.map((criterion, index) =>
        normalizeGherkinCriterion(criterion, ticket.summary, index),
      ),
    })),
  };
}

function semanticMessages(input: unknown): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const bundle = input as Partial<SpecFactoryDraftBundle> | null;
  const warnings = Array.isArray(bundle?.warnings) ? [...bundle.warnings] : [];

  if (!Array.isArray(bundle?.childTickets)) {
    return { errors, warnings };
  }

  bundle.childTickets.forEach((ticket, index) => {
    if (!ticket.technicalDetails?.repo?.trim()) {
      errors.push(`childTickets[${index}].technicalDetails.repo is required`);
    }
    if (
      !Array.isArray(ticket.acceptanceCriteria) ||
      ticket.acceptanceCriteria.length < 2
    ) {
      errors.push(
        `childTickets[${index}].acceptanceCriteria must contain at least 2 items`,
      );
    }
    if (ticket.technicalDetails?.repo !== ticket.repoName) {
      warnings.push(
        `childTickets[${index}] repoName differs from technicalDetails.repo`,
      );
    }
  });

  return { errors, warnings };
}

export function validateDraftBundle(input: unknown): DraftValidationResult {
  const parsed = SpecFactoryDraftBundleSchema.safeParse(input);
  if (!parsed.success) {
    const semantic = semanticMessages(input);
    return {
      valid: false,
      normalized: null,
      raw: input,
      errors: [
        ...parsed.error.issues.map((issue) =>
          `${issue.path.join(".")} ${issue.message}`.trim(),
        ),
        ...semantic.errors,
      ],
      warnings: semantic.warnings,
    };
  }

  const normalized = normalizeAcceptanceCriteria(parsed.data);
  const semantic = semanticMessages(normalized);

  return {
    valid: semantic.errors.length === 0,
    normalized,
    errors: semantic.errors,
    warnings: semantic.warnings,
  };
}
