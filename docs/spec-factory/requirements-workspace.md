# Requirements Workspace Contract

This document defines the user-facing Compose experience for Spec Factory. It
is the product contract for clarification, research consent, artifacts, agent
status, handoff, and draft quality.

## Audience and objective

The primary user is a business stakeholder, product owner, product manager, or
subject-matter expert. The workspace helps that user describe **what exists,
what outcome is needed, and what behavior must change**. The system owns how
the software will be implemented.

The output is a professional requirements package containing:

- a clear problem statement and proposed solution;
- business requirements and functional requirements;
- challenges, assumptions, risks, and unresolved business decisions;
- sequenced user stories with business value; and
- complete Gherkin acceptance criteria.

## Non-negotiable interaction rules

1. User-facing clarification is limited to business and functional questions.
2. Method, class, repository, schema, API, framework, deployment, and other
   implementation choices are never presented as user decisions.
3. Technical uncertainty becomes an implementation finding or a research task.
4. Sources begin conversion, distillation, and context merge automatically.
   There is no manual **Analyze Sources** action.
5. Code research requires explicit user consent after a clear problem
   statement exists. Repository selection and grounding are backend concerns.
6. LLM-authored context versions and control fields are advisory. Frozen
   backend values are authoritative for provenance and durable state.
7. An approved or ready draft is reused during context repair; repair must not
   overwrite a reviewed deliverable.

## Workspace information architecture

### Sources

The Sources list contains user-provided evidence such as files, notes, Jira,
Confluence, and media. Each source shows its conversion state. Adding a source
is the only analysis trigger the user needs.

Deleting a source immediately removes it from current requirements and also
invalidates generated research derived from it. A **Recently removed** row
offers Undo for the configured grace period. Undo restores and re-distills only
the original evidence; derived artifacts must be regenerated from current
context. Once the grace period expires, the retention worker physically erases
source-specific files and scrubs stored source content. Historical context and
handoff versions remain as superseded audit records, never as current output.

### Artifacts

Generated and synthesized material appears in a separate **Artifacts** section
in the left rail. Every item is inspectable without consuming chat height.

The section can contain:

- Current session context and its committed version;
- Problem statement;
- Proposed solution;
- Business requirements;
- Functional requirements;
- Challenges;
- User stories and Gherkin acceptance criteria;
- Conversation decisions, when present; and
- Generated code/configuration/repository research.

The former context-summary panel above chat is removed. Chat remains the main
working area, while Artifacts exposes the evolving requirements package.

### Background agents

The session toolbar shows four compact, authoritative status markers:

| Marker       | Responsibility                                      |
| ------------ | --------------------------------------------------- |
| Sources      | Conversion and source materialization               |
| Requirements | Distillation, context merge, and clarification work |
| Research     | Approved code/configuration investigation           |
| Draft        | Handoff, drafting, approval, and publication        |

Each marker reports `idle`, `working`, `waiting`, or `attention` from durable
workflow state. The client does not infer completion from elapsed time.

## Clarification policy

Allowed examples:

- Which customer groups need this capability?
- What outcome indicates that the workflow succeeded?
- Which exceptions should require manual review?
- Is this policy required for all products or only Medicare?

Disallowed examples:

- Should we reuse `submitAppeal()`?
- Which repository should own the endpoint?
- Should this be synchronous or queue-backed?
- Which table should store the status?

Disallowed questions are retained as implementation findings when useful, but
they are filtered at model output, persistence read, service projection, and UI
rendering boundaries so legacy data cannot leak them back to users.

## Research consent flow

1. Source processing or conversation produces a clear problem statement.
2. If no generated research exists and research is not already running, the
   chat asks whether the development agent may research the codebase.
3. **Start code research** records consent and queues bounded research.
4. **Not now** dismisses the prompt for the current context version. A material
   context change may ask again.
5. The backend resolves and attaches repository evidence; the user is not
   asked to choose repositories or implementation paths.
6. Research output is redacted, fenced, distilled as a generated source, and
   displayed under Artifacts.

## Requirements context contract

The committed context projection exposes these product fields in addition to
provenance and implementation evidence:

```json
{
  "problemStatement": "...",
  "solution": "...",
  "businessRequirements": ["..."],
  "functionalRequirements": ["..."],
  "challenges": ["..."],
  "decisions": ["..."],
  "openQuestions": ["business or functional only"],
  "stories": [
    {
      "title": "...",
      "userStory": "As a ..., I want ..., so that ...",
      "businessValue": "...",
      "acceptanceCriteria": ["Scenario: ...\nGiven ...\nWhen ...\nThen ..."],
      "sequence": 1
    }
  ]
}
```

Context merge preserves prior requirements unless evidence explicitly removes
or supersedes them. Technical observations live in implementation findings and
may inform stories, but they do not become questions for the business user.

## Story and acceptance-criteria quality

Each story must be independently understandable and contain:

- a concise outcome-oriented title;
- a complete `As a / I want / so that` user story;
- explicit business value;
- functional behavior and relevant exceptions;
- ordering or dependency information; and
- one or more full Gherkin scenarios.

Every acceptance criterion is normalized to:

```gherkin
Scenario: Descriptive behavior
Given a clear business precondition
When the user or system performs the behavior
Then an observable functional outcome occurs
```

The draft validator applies the same rule to Epic and child-ticket acceptance
criteria, including legacy one-line criteria.

## Handoff and repair

The immutable handoff bundle includes the requirements fields, conversation
decisions, generated research, evidence references, and Gherkin stories from a
frozen context version. Draft generation treats that frozen bundle as the
requirements authority.

Context repair may enrich a missing handoff or rebuild context, but it reuses a
ready or approved draft and preserves an already published Epic. Repository
cache startup is fail-fast and uses a dedicated writable Spec Factory cache
path so ownership problems are detected before workers accept work.

## Acceptance tests

- Adding a source starts processing without an Analyze button.
- Technical questions from current or legacy data never render to the user.
- A clear problem statement produces one dismissible research-consent prompt
  per context version when research is eligible.
- Starting research requires no repository picker and produces an Artifact.
- Context, problem, solution, requirements, challenges, stories, decisions,
  and generated research are inspectable in Artifacts.
- Agent markers reflect durable workflow state and survive refresh/reconnect.
- Generated acceptance criteria contain Scenario, Given, When, and Then.
- Context repair does not regenerate approved or ready drafts.
- Deleting a source removes its transitive generated-research descendants,
  cancels stale work, and produces a new context version without that evidence.
- Undo during the grace period restores only the original source and restarts
  distillation; expired Undo returns 410 and the source remains deleted.
- Concurrent research cannot publish a generated source against a deleted
  parent, and an already-published descendant is included in the deletion batch.
