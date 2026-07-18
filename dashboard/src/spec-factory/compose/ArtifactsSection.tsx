import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  BookOpenCheck,
  CheckCircle2,
  ClipboardList,
  FileJson2,
  Lightbulb,
  LoaderCircle,
  MessagesSquare,
  SearchCode,
  Target,
  X,
} from "lucide-react";
import { FormattedText } from "../SpecFactoryPage.js";
import type {
  ComposeContextProjection,
  ComposeContextProjectionSummary,
  ComposeReadiness,
  ComposeSourceSummary,
} from "./composeTypes.js";

interface RequirementArtifact {
  id: string;
  title: string;
  meta: string;
  content: string;
  icon: ReactNode;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function itemText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of [
    "text",
    "question",
    "title",
    "summary",
    "statement",
    "requirement",
    "fact",
    "claim",
    "evidence",
    "decision",
    "risk",
    "constraint",
    "description",
    "finding",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function listMarkdown(values: unknown[], limit?: number): string {
  const lines = values
    .map(itemText)
    .filter((value): value is string => Boolean(value));
  if (lines.length === 0) return "";
  const visible = limit ? lines.slice(0, limit) : lines;
  const remaining = lines.length - visible.length;
  return [
    visible.map((line) => `- ${line}`).join("\n"),
    remaining > 0
      ? `_Showing ${visible.length} of ${lines.length} items._`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function storyMarkdown(summary: ComposeContextProjectionSummary): string {
  const stories = summary.stories ?? [];
  return stories
    .slice()
    .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
    .map((story, index) =>
      [
        `## ${index + 1}. ${story.title}`,
        story.userStory || story.summary,
        story.businessValue ? `**Business value:** ${story.businessValue}` : "",
        ...(story.acceptanceCriteria ?? []).map((criterion) =>
          criterion.startsWith("Scenario:") ? criterion : `- ${criterion}`,
        ),
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\n\n");
}

function valueText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readinessValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function effectiveContextSummary(
  projection: ComposeContextProjection,
  readiness: ComposeReadiness | null,
): ComposeContextProjectionSummary | null {
  const current = projection.summary;
  if (current) return current;
  if (!readiness) return null;
  const nextStep = valueText(readiness.nextStep);

  return {
    objective: valueText(readiness.summary) ?? valueText(readiness.problem),
    problemStatement:
      valueText(readiness.problem) ?? valueText(readiness.summary),
    solution: valueText(readiness.solution) ?? valueText(readiness.ideating),
    businessRequirements: readinessValues(readiness.businessRequirements),
    functionalRequirements: readinessValues(readiness.functionalRequirements),
    challenges: readinessValues(readiness.challenges),
    stories: readiness.stories ?? [],
    recommendedNextActions: nextStep ? [nextStep] : [],
  };
}

function workingContextMarkdown(
  projection: ComposeContextProjection,
  summary: ComposeContextProjectionSummary | null,
): string {
  return [
    `# Working Context v${projection.version}`,
    summary?.problemStatement
      ? `## Problem Statement\n${summary.problemStatement}`
      : "",
    summary?.solution ? `## Solution Intent\n${summary.solution}` : "",
    summary?.businessRequirements?.length
      ? `## Business Requirements\n${listMarkdown(summary.businessRequirements)}`
      : "",
    summary?.functionalRequirements?.length
      ? `## Functional Requirements\n${listMarkdown(summary.functionalRequirements)}`
      : "",
    summary?.challenges?.length
      ? `## Product Challenges\n${listMarkdown(summary.challenges, 30)}`
      : "",
    (projection.requirements?.length ?? 0) > 0
      ? `## Requirements\n${listMarkdown(projection.requirements ?? [], 30)}`
      : "",
    (projection.facts?.length ?? 0) > 0
      ? `## Evidence and Facts\n${listMarkdown(projection.facts ?? [], 30)}`
      : "",
    (projection.implementationFindings?.length ?? 0) > 0
      ? `## Existing-system Findings\n${listMarkdown(projection.implementationFindings ?? [], 30)}`
      : "",
    (projection.constraints?.length ?? 0) > 0
      ? `## Constraints\n${listMarkdown(projection.constraints ?? [], 30)}`
      : "",
    (projection.decisions?.length ?? 0) > 0
      ? `## Decisions\n${listMarkdown(projection.decisions ?? [], 30)}`
      : "",
    (projection.risks?.length ?? 0) > 0
      ? `## Risks\n${listMarkdown(projection.risks ?? [], 30)}`
      : "",
    (projection.conflicts?.length ?? 0) > 0
      ? `## Unresolved Conflicts\n${listMarkdown(projection.conflicts ?? [], 30)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildArtifacts(
  projection: ComposeContextProjection | null,
  readiness: ComposeReadiness | null,
  generatedSources: ComposeSourceSummary[],
): RequirementArtifact[] {
  const artifacts: RequirementArtifact[] = [];
  if (projection) {
    const summary = effectiveContextSummary(projection, readiness);
    artifacts.push({
      id: `context-${projection.version}`,
      title: `Working context v${projection.version}`,
      meta: "Current session context",
      content: workingContextMarkdown(projection, summary),
      icon: <FileJson2 size={15} aria-hidden="true" />,
    });
    if (summary?.problemStatement) {
      artifacts.push({
        id: `problem-${projection.version}`,
        title: "Problem statement",
        meta: `Context v${projection.version}`,
        content: summary.problemStatement,
        icon: <Target size={15} aria-hidden="true" />,
      });
    }
    if (summary?.solution) {
      artifacts.push({
        id: `solution-${projection.version}`,
        title: "Solution",
        meta: `Context v${projection.version}`,
        content: summary.solution,
        icon: <Lightbulb size={15} aria-hidden="true" />,
      });
    }
    if (summary?.businessRequirements?.length) {
      artifacts.push({
        id: `business-${projection.version}`,
        title: "Business requirements",
        meta: countLabel(summary.businessRequirements.length, "requirement"),
        content: listMarkdown(summary.businessRequirements),
        icon: <BookOpenCheck size={15} aria-hidden="true" />,
      });
    }
    if (summary?.functionalRequirements?.length) {
      artifacts.push({
        id: `functional-${projection.version}`,
        title: "Functional requirements",
        meta: countLabel(summary.functionalRequirements.length, "requirement"),
        content: listMarkdown(summary.functionalRequirements),
        icon: <ClipboardList size={15} aria-hidden="true" />,
      });
    }
    if (summary?.challenges?.length) {
      artifacts.push({
        id: `challenges-${projection.version}`,
        title: "Challenges",
        meta: `${summary.challenges.length} identified`,
        content: listMarkdown(summary.challenges),
        icon: <AlertCircle size={15} aria-hidden="true" />,
      });
    }
    if (summary?.stories?.length) {
      artifacts.push({
        id: `stories-${projection.version}`,
        title: "Product stories",
        meta: countLabel(summary.stories.length, "story"),
        content: storyMarkdown(summary),
        icon: <ClipboardList size={15} aria-hidden="true" />,
      });
    }
    if ((projection.decisions?.length ?? 0) > 0) {
      artifacts.push({
        id: `conversation-${projection.version}`,
        title: "Conversation decisions",
        meta: countLabel(projection.decisions?.length ?? 0, "decision"),
        content: listMarkdown(projection.decisions ?? []),
        icon: <MessagesSquare size={15} aria-hidden="true" />,
      });
    }
  }
  for (const source of generatedSources) {
    artifacts.push({
      id: `generated-${source.id}`,
      title: source.originalFilename ?? `Research artifact ${source.id}`,
      meta: source.contextVersionUsed
        ? `Code research · Context v${source.contextVersionUsed}`
        : "Code research",
      content:
        source.markdownContent?.trim() ||
        source.sourceSummary?.trim() ||
        "Research artifact is still being prepared.",
      icon: <SearchCode size={15} aria-hidden="true" />,
    });
  }
  return artifacts;
}

export function ArtifactsSection({
  projection,
  readiness,
  generatedSources,
  updating,
  embedded = false,
}: {
  projection: ComposeContextProjection | null;
  readiness: ComposeReadiness | null;
  generatedSources: ComposeSourceSummary[];
  updating: boolean;
  embedded?: boolean;
}) {
  const [selected, setSelected] = useState<RequirementArtifact | null>(null);
  const artifacts = useMemo(
    () => buildArtifacts(projection, readiness, generatedSources),
    [projection, readiness, generatedSources],
  );

  return (
    <section
      className={`sf-artifacts${embedded ? " is-embedded" : ""}`}
      aria-label="Artifacts"
    >
      {embedded ? (
        <div className="sf-artifact-count">
          {updating
            ? "Updating artifacts..."
            : `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`}
        </div>
      ) : (
        <div className="sf-artifacts-head">
          <strong>Artifacts</strong>
          <span>{updating ? "Updating" : artifacts.length}</span>
        </div>
      )}
      {artifacts.length === 0 ? (
        <div className="sf-artifacts-empty">
          {updating ? (
            <LoaderCircle
              size={15}
              className="is-spinning"
              aria-hidden="true"
            />
          ) : (
            <FileJson2 size={15} aria-hidden="true" />
          )}
          <span>
            {updating ? "Building requirements" : "Waiting for context"}
          </span>
        </div>
      ) : (
        <ul className="sf-artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button type="button" onClick={() => setSelected(artifact)}>
                <span className="sf-artifact-icon">{artifact.icon}</span>
                <span className="sf-artifact-copy">
                  <strong>{artifact.title}</strong>
                  <small>{artifact.meta}</small>
                </span>
                {updating && artifact.id.startsWith("context-") ? (
                  <LoaderCircle
                    size={14}
                    className="is-spinning"
                    aria-label="Updating"
                  />
                ) : (
                  <CheckCircle2 size={14} aria-label="Ready" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected ? (
        <ArtifactModal artifact={selected} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}

function ArtifactModal({
  artifact,
  onClose,
}: {
  artifact: RequirementArtifact;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const modal = (
    <div
      className="sf-source-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="sf-source-modal sf-artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-artifact-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          type="button"
          className="sf-source-close"
          aria-label="Close artifact"
          onClick={onClose}
        >
          <X size={22} aria-hidden="true" />
        </button>
        <header className="sf-source-modal-header">
          <span>{artifact.meta}</span>
          <h2 id="sf-artifact-modal-title">{artifact.title}</h2>
        </header>
        <div className="sf-artifact-document">
          <FormattedText text={artifact.content} />
        </div>
      </section>
    </div>
  );
  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}
