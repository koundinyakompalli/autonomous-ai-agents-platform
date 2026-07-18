import type {
  SpecFactoryChildTicketDraft,
  SpecFactoryDraftBundle,
} from "./types.js";

function bullet(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function renderEpicDescription(bundle: SpecFactoryDraftBundle): string {
  return [
    "## Summary",
    bundle.epic.description,
    "",
    "## Business Context",
    bullet(bundle.epic.businessContext),
    "",
    "## Acceptance Summary",
    bullet(bundle.epic.acceptanceCriteria),
    "",
    "## Dependencies",
    bullet(bundle.epic.dependencies),
    "",
    "## Assumptions",
    bullet(bundle.epic.assumptions),
    "",
    "## Source Evidence",
    bullet(bundle.evidenceSummary),
    "",
    `Generated from ${bundle.sourceJiraKey} by Spec Factory.`,
  ].join("\n");
}

export function renderChildTicketDescription(ticket: SpecFactoryChildTicketDraft): string {
  const details = [
    `Repo: ${ticket.technicalDetails.repo}`,
    ticket.technicalDetails.branch ? `Branch: ${ticket.technicalDetails.branch}` : null,
    ticket.technicalDetails.targetFiles.length
      ? ["Target Files:", bullet(ticket.technicalDetails.targetFiles)].join("\n")
      : null,
    "Implementation Notes:",
    bullet(ticket.technicalDetails.implementationNotes),
  ].filter(Boolean);

  return [
    "## Summary",
    ticket.summary,
    "",
    "## LOE Estimate",
    ticket.loeHours == null ? "Not provided" : `${ticket.loeHours} hours`,
    "",
    "## Overview",
    ticket.overview,
    "",
    "## Acceptance Criteria",
    bullet(ticket.acceptanceCriteria),
    "",
    "## Technical Details",
    details.join("\n"),
    "",
    "## Out of Scope",
    bullet(ticket.outOfScope),
    "",
    "## Testing Notes",
    bullet(ticket.testingNotes),
    "",
    "## Source Evidence",
    bullet(ticket.sourceEvidenceRefs),
  ].join("\n");
}

export function renderDraftMarkdown(bundle: SpecFactoryDraftBundle): string {
  const childSections = bundle.childTickets.map((ticket, index) =>
    [
      `# Child Story ${index + 1}: ${ticket.repoName}`,
      "",
      renderChildTicketDescription(ticket),
    ].join("\n"),
  );

  const sections = [
    [`# Epic: ${bundle.epic.summary}`, "", renderEpicDescription(bundle)].join("\n"),
    ...childSections,
  ];

  return sections.join("\n\n---\n\n");
}
