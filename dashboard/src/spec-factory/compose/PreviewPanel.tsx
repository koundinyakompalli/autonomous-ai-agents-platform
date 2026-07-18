import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  FileCheck2,
  ListChecks,
  MessageCircleQuestion,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import { Confetti } from "./Confetti.js";
import type {
  ComposeContextProjection,
  ComposeOpenQuestion,
  ComposeReadiness,
} from "./composeTypes.js";
import {
  isImplementationDetail,
  isUserFacingClarification,
} from "./clarificationPolicy.js";

type BriefTab = "brief" | "requirements" | "evidence" | "activity";

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nonEmptyItems(values: string[] | null | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function visibleItems(values: string[] | null | undefined): string[] {
  return nonEmptyItems(values).filter((item) => !isImplementationDetail(item));
}

function readinessPercent(readiness: ComposeReadiness): number {
  const confidence = readiness.confidence?.score;
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    return Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  }
  if (readiness.ready) return 100;
  const questions = readiness.questions ?? [];
  if (questions.length === 0) return readiness.summary.trim() ? 35 : 10;
  const answered = questions.filter((question) => question.answered).length;
  return Math.round((answered / questions.length) * 100);
}

function requirementArea(value: string): string {
  const normalized = value.toLowerCase();
  if (/\b(provider|search|filter|specialty|taxonomy)\b/.test(normalized)) {
    return "Provider search & filters";
  }
  if (/\b(case|status|track|history|visibility|audit)\b/.test(normalized)) {
    return "Case tracking & visibility";
  }
  if (
    /\b(validate|rule|required|mandatory|permission|role)\b/.test(normalized)
  ) {
    return "Validation & rules";
  }
  if (/\b(api|service|integration|system|sync|event)\b/.test(normalized)) {
    return "Systems & integrations";
  }
  return "Data capture";
}

function requirementGroups(readiness: ComposeReadiness) {
  const values = [
    ...visibleItems(readiness.businessRequirements),
    ...visibleItems(readiness.functionalRequirements),
  ];
  const groups = new Map<string, number>();
  for (const value of values) {
    const area = requirementArea(value);
    groups.set(area, (groups.get(area) ?? 0) + 1);
  }
  return Array.from(groups.entries()).map(([label, count]) => ({
    label,
    count,
  }));
}

function draftButtonLabel({
  handingOff,
  workflowLabel,
  hasGeneratedEpic,
  canReviewDraft,
  readyForPreview,
}: {
  handingOff: boolean;
  workflowLabel?: string | null;
  hasGeneratedEpic: boolean;
  canReviewDraft: boolean;
  readyForPreview: boolean;
}): string {
  if (hasGeneratedEpic) return "View Epic";
  if (canReviewDraft) return "Review draft";
  if (handingOff) return workflowLabel || "Preparing draft";
  return readyForPreview ? "Generate Draft" : "Draft anyway";
}

export function PreviewPanel({
  readiness: inputReadiness,
  handingOff,
  handoffBlockedReason,
  generatedSourceId,
  epicKey,
  draftReady,
  workflowLabel,
  sourceCount = 0,
  contextProjection = null,
  onGenerate,
  onViewEpic,
  onSelectQuestion,
}: {
  readiness: ComposeReadiness | null;
  handingOff: boolean;
  handoffBlockedReason?: string | null;
  generatedSourceId?: number | null;
  epicKey?: string | null;
  draftReady?: boolean;
  workflowLabel?: string | null;
  sourceCount?: number;
  contextProjection?: ComposeContextProjection | null;
  onGenerate: () => void;
  onViewEpic?: () => void;
  onSelectQuestion?: (question: ComposeOpenQuestion) => void;
}) {
  const [activeTab, setActiveTab] = useState<BriefTab>("brief");
  const projectionSummary = contextProjection?.summary;
  const readiness: ComposeReadiness | null =
    inputReadiness ??
    (projectionSummary
      ? {
          ready: false,
          openQuestions: [],
          summary:
            projectionSummary.problemStatement ??
            projectionSummary.objective ??
            "",
          problem: projectionSummary.problemStatement ?? undefined,
          solution: projectionSummary.solution ?? undefined,
          businessRequirements: projectionSummary.businessRequirements,
          functionalRequirements: projectionSummary.functionalRequirements,
          challenges: projectionSummary.challenges,
          stories: projectionSummary.stories,
        }
      : null);

  if (!readiness) {
    return (
      <section
        className="sf-compose-panel sf-preview-panel"
        aria-label="Requirements brief"
      >
        <header className="sf-brief-header">
          <h1>Requirements Brief</h1>
        </header>
        <div className="sf-brief-empty">
          <FileCheck2 size={22} aria-hidden="true" />
          <strong>Your brief will take shape here</strong>
          <p>Add a source or describe the outcome in chat to begin.</p>
        </div>
      </section>
    );
  }

  const userFacingOpenQuestions = readiness.openQuestions.filter(
    isUserFacingClarification,
  );
  const structuredQuestions = (readiness.questions ?? []).filter(
    (question) => !question.answered && isUserFacingClarification(question),
  );
  const readyForPreview =
    readiness.ready && userFacingOpenQuestions.length === 0;
  const hasGeneratedEpic = Boolean(epicKey?.trim());
  const canReviewDraft =
    Boolean(draftReady) &&
    typeof generatedSourceId === "number" &&
    Number.isFinite(generatedSourceId);
  const progress = readinessPercent(readiness);
  const decisionsMade = (readiness.questions ?? []).filter(
    (question) => question.answered,
  ).length;
  const conflictCount = contextProjection?.conflicts?.length ?? 0;
  const businessRequirements = visibleItems(
    readiness.businessRequirements?.length
      ? readiness.businessRequirements
      : projectionSummary?.businessRequirements,
  );
  const functionalRequirements = visibleItems(
    readiness.functionalRequirements?.length
      ? readiness.functionalRequirements
      : projectionSummary?.functionalRequirements,
  );
  const challenges = visibleItems(
    readiness.challenges?.length
      ? readiness.challenges
      : projectionSummary?.challenges,
  );
  const stories = readiness.stories?.length
    ? readiness.stories
    : (projectionSummary?.stories ?? []);
  const requirements = [...businessRequirements, ...functionalRequirements];
  const groups = requirementGroups({
    ...readiness,
    businessRequirements,
    functionalRequirements,
  });
  const problem =
    normalizedText(readiness.problem) ||
    normalizedText(projectionSummary?.problemStatement) ||
    normalizedText(readiness.summary);
  const outcomes = businessRequirements;
  const risks = visibleItems(readiness.risks);
  const assumptions = visibleItems(readiness.assumptions);
  const missingEvidence = visibleItems(readiness.missingEvidence);
  const warningMessages = (readiness.validatorWarnings ?? [])
    .map((warning) => warning.message.trim())
    .filter((message) => message && !isImplementationDetail(message));
  const draftLabel = draftButtonLabel({
    handingOff,
    workflowLabel,
    hasGeneratedEpic,
    canReviewDraft,
    readyForPreview,
  });

  return (
    <section
      className="sf-compose-panel sf-preview-panel"
      aria-label="Requirements brief"
    >
      {readyForPreview ? <Confetti /> : null}
      <header className="sf-brief-header">
        <div>
          <h1>Requirements Brief</h1>
          {workflowLabel ? <span>{workflowLabel}</span> : null}
        </div>
      </header>

      <section className="sf-readiness-overview" aria-label="Readiness summary">
        <div className="sf-readiness-score">
          <strong>{progress}%</strong>
          <span>Overall completeness</span>
          <progress
            value={progress}
            max={100}
            aria-label="Requirements progress"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        <ul>
          <li>
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>Sources reviewed</span>
            <strong>{sourceCount}</strong>
          </li>
          <li>
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>Decisions made</span>
            <strong>{decisionsMade}</strong>
          </li>
          <li>
            <CircleHelp size={14} aria-hidden="true" />
            <span>Open questions</span>
            <strong>
              {structuredQuestions.length || userFacingOpenQuestions.length}
            </strong>
          </li>
          <li>
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Conflicts</span>
            <strong>{conflictCount}</strong>
          </li>
        </ul>
        <dl className="sf-readiness-delivery" aria-label="Delivery profile">
          <div>
            <dt>Module</dt>
            <dd>{readiness.details?.module || "TBD"}</dd>
          </div>
          <div>
            <dt>Repositories</dt>
            <dd title={readiness.details?.repositories?.join(", ") || "TBD"}>
              {readiness.details?.repositories?.join(", ") || "TBD"}
            </dd>
          </div>
          <div>
            <dt>Difficulty</dt>
            <dd>{readiness.details?.difficulty || "TBD"}</dd>
          </div>
          <div>
            <dt>Story points</dt>
            <dd>{readiness.details?.storyPoints ?? "TBD"}</dd>
          </div>
          <div>
            <dt>LOE</dt>
            <dd>
              {readiness.details?.loeHours != null
                ? `${readiness.details.loeHours}h`
                : "TBD"}
            </dd>
          </div>
        </dl>
      </section>

      {structuredQuestions.length > 0 ? (
        <button
          type="button"
          className="sf-brief-decisions"
          onClick={() => onSelectQuestion?.(structuredQuestions[0])}
        >
          <span>
            {structuredQuestions.length} decision
            {structuredQuestions.length === 1 ? "" : "s"} pending
          </span>
          <strong>
            Review now <ChevronRight size={14} aria-hidden="true" />
          </strong>
        </button>
      ) : null}

      <div className="sf-brief-tabs" role="tablist" aria-label="Brief views">
        {(
          [
            ["brief", "Brief"],
            ["requirements", "Requirements"],
            ["evidence", "Evidence"],
            ["activity", "Activity"],
          ] as Array<[BriefTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? "is-active" : ""}
            onClick={() => setActiveTab(id)}
          >
            {label}
            {id === "requirements" && requirements.length > 0 ? (
              <span>{requirements.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="sf-preview-body">
        {activeTab === "brief" ? (
          <>
            <BriefSection
              title="Problem"
              icon={<Target size={15} aria-hidden="true" />}
            >
              <p>{problem || "Describe the business problem in chat."}</p>
            </BriefSection>
            <BriefSection
              title="Business outcomes"
              icon={<Sparkles size={15} aria-hidden="true" />}
            >
              {outcomes.length > 0 ? (
                <ul className="sf-brief-checklist">
                  {outcomes.slice(0, 6).map((outcome, index) => (
                    <li key={`${outcome}-${index}`}>
                      <CheckCircle2 size={14} aria-hidden="true" />
                      <span>{outcome}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No business outcomes captured yet.</p>
              )}
            </BriefSection>
            <BriefSection
              title="Requirements by area"
              icon={<ListChecks size={15} aria-hidden="true" />}
            >
              {groups.length > 0 ? (
                <ul className="sf-requirement-groups">
                  {groups.map((group) => (
                    <li key={group.label}>
                      <span>{group.label}</span>
                      <strong>{group.count}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>Requirements will appear as the brief develops.</p>
              )}
            </BriefSection>
            <BriefSection
              title={`Open questions (${structuredQuestions.length || userFacingOpenQuestions.length})`}
              icon={<MessageCircleQuestion size={15} aria-hidden="true" />}
            >
              {structuredQuestions.length > 0 ? (
                <div
                  className="sf-question-tiles"
                  role="group"
                  aria-label="Questions for you"
                >
                  {structuredQuestions.map((question) => (
                    <button
                      key={question.id}
                      type="button"
                      className="sf-question-tile"
                      onClick={() => onSelectQuestion?.(question)}
                    >
                      <span>{question.question}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : userFacingOpenQuestions.length > 0 ? (
                <ul aria-label="Questions for you">
                  {userFacingOpenQuestions.map((question, index) => (
                    <li key={`${question}-${index}`}>{question}</li>
                  ))}
                </ul>
              ) : (
                <p>No open business or functional questions.</p>
              )}
              {handoffBlockedReason ? (
                <p className="sf-preview-blocked" role="note">
                  {handoffBlockedReason}
                </p>
              ) : null}
            </BriefSection>
          </>
        ) : null}

        {activeTab === "requirements" ? (
          <>
            <BriefList
              title="Business requirements"
              items={businessRequirements}
            />
            <BriefList
              title="Functional requirements"
              items={functionalRequirements}
            />
            <BriefList title="Challenges" items={challenges} />
            {stories.length ? (
              <BriefSection
                title={`Product stories (${stories.length})`}
                icon={<ListChecks size={15} aria-hidden="true" />}
              >
                <ol className="sf-brief-stories">
                  {stories.slice(0, 8).map((story) => (
                    <li key={story.id}>
                      <strong>{story.title}</strong>
                      <span>{story.userStory || story.summary}</span>
                      {story.acceptanceCriteria?.length ? (
                        <ul
                          aria-label={`Acceptance criteria for ${story.title}`}
                        >
                          {story.acceptanceCriteria.map((criterion, index) => (
                            <li key={`${story.id}-criterion-${index}`}>
                              <code>{criterion}</code>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </BriefSection>
            ) : null}
          </>
        ) : null}

        {activeTab === "evidence" ? (
          <article
            className="sf-preview-signals"
            aria-label="Readiness signals"
          >
            <BriefList title="Missing evidence" items={missingEvidence} />
            <BriefList title="Risks" items={risks} />
            <BriefList title="Assumptions" items={assumptions} />
            <BriefList title="Warnings" items={warningMessages} />
            {!missingEvidence.length &&
            !risks.length &&
            !assumptions.length &&
            !warningMessages.length ? (
              <p>No outstanding readiness signals.</p>
            ) : null}
          </article>
        ) : null}

        {activeTab === "activity" ? (
          <article className="sf-brief-activity" aria-label="Activity">
            <strong>{workflowLabel || "Brief is up to date"}</strong>
            <p>
              Context version {contextProjection?.version ?? "not available"}.
              The brief updates automatically when sources, decisions, or
              research change.
            </p>
          </article>
        ) : null}
      </div>

      <footer className="sf-brief-footer">
        {structuredQuestions.length > 0 ? (
          <button
            type="button"
            className="sf-brief-resolve"
            onClick={() => onSelectQuestion?.(structuredQuestions[0])}
          >
            <MessageCircleQuestion size={16} aria-hidden="true" />
            Resolve {structuredQuestions.length} decision
            {structuredQuestions.length === 1 ? "" : "s"}
          </button>
        ) : null}
        <button
          type="button"
          className={`sf-button sf-button-primary ${readyForPreview ? "is-ready" : ""}`}
          onClick={hasGeneratedEpic || canReviewDraft ? onViewEpic : onGenerate}
          disabled={
            hasGeneratedEpic || canReviewDraft
              ? !onViewEpic
              : handingOff || Boolean(handoffBlockedReason)
          }
        >
          <Sparkles size={16} aria-hidden="true" />
          {draftLabel}
        </button>
      </footer>
    </section>
  );
}

function BriefSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sf-brief-section">
      <h2>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function BriefList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <BriefSection
      title={title}
      icon={
        title === "Risks" || title === "Warnings" ? (
          <ShieldAlert size={15} aria-hidden="true" />
        ) : (
          <ListChecks size={15} aria-hidden="true" />
        )
      }
    >
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </BriefSection>
  );
}
