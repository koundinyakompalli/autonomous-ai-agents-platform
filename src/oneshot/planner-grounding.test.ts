import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyGroundingToPlan,
  buildPlannerEvidenceContext,
  buildPlannerGroundingContext,
  extractPlannerGroundingTerms,
  formatPlannerEvidenceForPrompt,
  formatPlannerGroundingForPrompt,
  isPlannerEvidenceStrong,
  isPlannerGroundingStrong,
  validatePlanAgainstGrounding,
} from "./planner-grounding.js";
import { parseOneShotPlan } from "./schema/plan.js";

let workspacePath: string;

const RUN_605_EVENT_TARGET =
  "MedicalMgmt/src/main/java/com/medhok/mm/server/event/CodeClassifierConfigChangedEvent.java";
const RUN_605_EVENT_PACKAGE = "com.medhok.mm.server.event";
const RUN_605_MODULE_EVIDENCE =
  "MedicalMgmt/src/main/java/com/medhok/mm/server/service/CodesMasterService.java";

function run605Grounding() {
  return {
    generatedAt: "2026-07-01T12:00:00.000Z",
    jiraKey: "CPDEV-25292",
    repoName: "core-app",
    confidence: "strong" as const,
    terms: [
      {
        value: "CodeClassifierConfigChangedEvent",
        kind: "identifier" as const,
        weight: 10,
      },
      { value: "CodesMasterService", kind: "identifier" as const, weight: 10 },
    ],
    routeCards: [],
    candidateFiles: [
      {
        path: RUN_605_MODULE_EVIDENCE,
        score: 30,
        reasons: ["content match"],
        matchedTerms: ["CodesMasterService"],
        exists: true,
      },
    ],
    snippets: [
      {
        file: RUN_605_MODULE_EVIDENCE,
        line: 42,
        term: "CodesMasterService",
        text: "public class CodesMasterService saves code classifier updates",
      },
    ],
    sourceTestPairs: [],
    ticketExplicitNewSourceCandidates: [
      {
        className: "CodeClassifierConfigChangedEvent",
        fileName: "CodeClassifierConfigChangedEvent.java",
        packageName: RUN_605_EVENT_PACKAGE,
        sources: ["ticket_description"],
        evidenceText:
          "Create class CodeClassifierConfigChangedEvent.java in package com.medhok.mm.server.event",
      },
      {
        className: "CodesMasterSavedEvent",
        fileName: "CodesMasterSavedEvent.java",
        packageName: RUN_605_EVENT_PACKAGE,
        sources: ["ticket_comment:10001"],
        evidenceText:
          "Create class CodesMasterSavedEvent.java in package com.medhok.mm.server.event",
      },
    ],
    riskFiles: [],
    warnings: [],
  };
}

function run605Plan(
  targetFile = RUN_605_EVENT_TARGET,
  supportingEvidence: string[] = [
    "Ticket evidence names CodeClassifierConfigChangedEvent.java in package com.medhok.mm.server.event.",
    `Read ${RUN_605_MODULE_EVIDENCE} for the affected code classifier save surface.`,
  ],
) {
  return parseOneShotPlan({
    jiraKey: "CPDEV-25292",
    repoName: "core-app",
    branchName: "medhok-monorepo-4.0",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Add code classifier save events.",
    specs: [
      {
        id: "code-classifier-events",
        objective: "Create ticket-required code classifier save event classes.",
        acceptanceCriteria: [
          "Code classifier saves publish ticket-required event payloads.",
        ],
        targetFiles: [targetFile],
        implementationNotes: [
          "Create only the ticket-named event classes in the event package.",
        ],
        validationSteps: ["mvn -f MedicalMgmt/pom.xml test"],
      },
    ],
    fileChangeContract: [
      {
        path: targetFile,
        role: "runtime_required",
        editable: true,
        rationale:
          "The ticket explicitly requires this new event class and the service evidence anchors the affected module.",
        supportingEvidence,
        allowedChanges: ["Create the ticket-required event class."],
      },
    ],
  });
}

async function writeFile(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

describe("planner grounding", () => {
  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-grounding-test-"),
    );
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("extracts ticket terms without depending on an LLM", () => {
    const terms = extractPlannerGroundingTerms(
      "Enable active-only default for MemberSearchForm in the member search flow.",
    );

    expect(terms.map((term) => term.value)).toContain("MemberSearchForm");
    expect(terms.map((term) => term.value)).toContain("member search");
  });

  it("grounds a synthetic member-search ticket to source, handler, and tests", async () => {
    await writeFile(
      "src/member/MemberSearchForm.ts",
      "export function getMemberSearchDefaults() { return { activeOnly: false } }\n",
    );
    await writeFile(
      "src/member/MemberSearchHandler.ts",
      "export function handleMemberSearch() { return getMemberSearchDefaults() }\n",
    );
    await writeFile(
      "src/member/MemberSearchForm.test.ts",
      'import { getMemberSearchDefaults } from "./MemberSearchForm"\n',
    );
    await writeFile(
      "package.json",
      JSON.stringify({
        scripts: {
          test: "vitest run",
          build: "tsc -p tsconfig.json",
        },
      }),
    );

    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "local-core-app-fixture",
      jiraKey: "LOCAL-E2E-1",
      ticketSummary: "Enable active-only default for member search.",
      taskDescription:
        "Change MemberSearchForm so activeOnly defaults to true.",
      qualificationSummary: {
        requirementsSummary: ["Member search defaults set activeOnly to true."],
      },
    });

    expect(isPlannerGroundingStrong(grounding)).toBe(true);
    expect(grounding.candidateFiles.map((file) => file.path)).toContain(
      "src/member/MemberSearchForm.ts",
    );
    expect(grounding.candidateFiles.map((file) => file.path)).toContain(
      "src/member/MemberSearchHandler.ts",
    );
    expect(grounding.sourceTestPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFile: "src/member/MemberSearchForm.ts",
          testFiles: expect.arrayContaining([
            "src/member/MemberSearchForm.test.ts",
          ]),
        }),
      ]),
    );
    expect(grounding.testCommand).toBe("npm test");
    expect(formatPlannerGroundingForPrompt(grounding)).toContain(
      "## Deterministic Planner Grounding",
    );
  });

  it("uses core-app route cards as reviewed waypoints, not hard answers", async () => {
    await writeFile(
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      "public class MemberSearchForm { void showMemberSearchButton() {} }\n",
    );
    await writeFile(
      "MedicalMgmt/src/main/java/com/medhok/mm/server/handlers/MemberSearchHandler.java",
      "public class MemberSearchHandler {}\n",
    );
    await writeFile(
      "MedicalMgmt/pom.xml",
      "<project><dependencies></dependencies></project>\n",
    );

    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "core-app",
      jiraKey: "CPDEV-1",
      ticketSummary:
        "Update MemberSearchForm button styling for member search.",
      taskDescription:
        "Keep the SmartGWT member search button behavior unchanged.",
    });

    expect(grounding.routeCards.map((card) => card.id)).toContain(
      "core-app.member-search-form",
    );
    expect(grounding.candidateFiles[0].path).toBe(
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
    );
    expect(grounding.testCommand).toBe("mvn -f MedicalMgmt/pom.xml test");
  });

  it("reports weak grounding when nothing in the repo matches the ticket", async () => {
    await writeFile("src/unrelated/Other.ts", "export const value = 1\n");

    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "local-core-app-fixture",
      jiraKey: "LOCAL-E2E-2",
      ticketSummary: "Enable impossible pfos-only frobnicator routing.",
      taskDescription: "No local source file contains these terms.",
    });

    expect(grounding.confidence).toBe("weak");
    expect(grounding.warnings).toContain(
      "No candidate files matched ticket terms.",
    );
  });

  it("does not treat ticket-key and generic domain snippets as strong deterministic grounding", () => {
    expect(
      isPlannerGroundingStrong({
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "CPDEV-18975",
        repoName: "core-app",
        confidence: "strong",
        terms: [{ value: "CPDEV", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "docs/old-ticket.md",
            score: 30,
            reasons: ["content match", "file path match"],
            matchedTerms: ["CPDEV", "Case"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "docs/old-ticket.md",
            line: 1,
            term: "CPDEV",
            text: "Related ticket CPDEV-12345",
          },
        ],
        sourceTestPairs: [],
        riskFiles: [],
        warnings: [],
      }),
    ).toBe(false);
  });

  it("treats trusted qualification inspection as strong grounding without snippets", async () => {
    await writeFile(
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      "public class MemberSearchForm {}\n",
    );

    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "core-app",
      jiraKey: "CPDEV-20908",
      ticketSummary: "Style cancel button",
      taskDescription:
        "No grep-friendly ticket terms are required for this assertion.",
      qualificationSummary: {
        qualified: true,
        requirementsSummary: ["Style the Member Search cancel button."],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        repoInspectionPerformed: true,
        inspectedFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        ],
        inspectionSummary:
          "Confirmed MemberSearchForm.java exists and cancelButton is constructed at line 1258.",
      },
    });

    expect(isPlannerGroundingStrong(grounding)).toBe(true);
    expect(grounding.qualificationEvidence).toMatchObject({
      trusted: true,
      verifiedInspectedFiles: [
        "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      ],
    });
    expect(grounding.candidateFiles.map((file) => file.path)).toContain(
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
    );
    expect(formatPlannerGroundingForPrompt(grounding)).toContain(
      "Qualification Inspection Evidence",
    );
  });

  it("does not trust qualification inspection when readiness checks fail", async () => {
    await writeFile(
      "src/member/MemberSearchForm.ts",
      "export const form = true\n",
    );

    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "local-core-app-fixture",
      jiraKey: "LOCAL-E2E-3",
      ticketSummary: "Style cancel button",
      taskDescription: "No local source file contains enough matching terms.",
      qualificationSummary: {
        qualified: false,
        requirementsSummary: ["Style the cancel button."],
        acceptanceCriteriaPresent: false,
        blockingReasons: ["Ticket is ambiguous."],
        repoInspectionPerformed: true,
        inspectedFiles: ["src/member/MemberSearchForm.ts"],
        inspectionSummary: "Confirmed possible file path.",
      },
    });

    expect(grounding.qualificationEvidence?.trusted).toBe(false);
    expect(grounding.confidence).not.toBe("strong");
    expect(isPlannerGroundingStrong(grounding)).toBe(false);
  });

  it("does not trust qualification inspection when inspected files are missing", async () => {
    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "core-app",
      jiraKey: "CPDEV-20908",
      ticketSummary: "Style cancel button",
      taskDescription: "The inspected file does not exist in this workspace.",
      qualificationSummary: {
        qualified: true,
        requirementsSummary: ["Style the cancel button."],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        repoInspectionPerformed: true,
        inspectedFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        ],
        inspectionSummary: "Claimed MemberSearchForm.java exists.",
      },
    });

    expect(grounding.qualificationEvidence).toMatchObject({
      trusted: false,
      verifiedInspectedFiles: [],
    });
    expect(grounding.qualificationEvidence?.reasons).toContain(
      "qualification inspected files were not found in the workspace",
    );
    expect(isPlannerGroundingStrong(grounding)).toBe(false);
  });

  it("rejects target files not backed by strong grounding evidence", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Bad target file",
      specs: [
        {
          id: "spec-1",
          objective: "Edit an unsupported file.",
          acceptanceCriteria: ["Unsupported file is rejected."],
          targetFiles: ["src/unrelated/Other.ts"],
          implementationNotes: ["No grounding supports this file."],
          validationSteps: ["npm test"],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      confidence: "strong",
      terms: [{ value: "MemberSearchForm", kind: "identifier", weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/member/MemberSearchForm.ts",
          score: 10,
          reasons: ["content match", "file path match"],
          matchedTerms: ["MemberSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/member/MemberSearchForm.ts",
          line: 1,
          term: "MemberSearchForm",
          text: "export function getMemberSearchDefaults()",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors[0]).toContain("src/unrelated/Other.ts");
  });

  it("accepts run-607 shaped ticket-backed new React page targets when repo templates are cited", async () => {
    await writeFile(
      "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
      "export function CorrespondenceTemplateStudioPage() { return <Tabs />; }\n",
    );
    await writeFile(
      "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.module.scss",
      ".page { height: 100vh; }\n",
    );
    await writeFile(
      "src/document-ai/pages/correspondence-template-studio/index.ts",
      "export { CorrespondenceTemplateStudioPage } from './correspondence-template-studio-page';\n",
    );
    await writeFile(
      "src/core/design-system/components/tabs/tabs.tsx",
      "export function Tabs() { return null; }\n",
    );
    await writeFile(
      "src/document-ai/pages/document-ai-layout.tsx",
      "export function DocumentAiLayout() { return null; }\n",
    );
    await writeFile(
      "src/core/routes/index.ts",
      "export enum RoutePath { CorrespondenceTemplateStudio = '/document-ai/correspondence-template-studio' }\n",
    );

    const pageFile =
      "src/document-ai/pages/policy-library/policy-library-page.tsx";
    const styleFile =
      "src/document-ai/pages/policy-library/policy-library-page.module.scss";
    const barrelFile = "src/document-ai/pages/policy-library/index.ts";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-25090",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary:
        "Create the Policy Library React full-screen overlay with tabs.",
      specs: [
        {
          id: "policy-library-page",
          objective:
            "Create the Policy Library page shell from inspected overlay templates.",
          acceptanceCriteria: [
            "Policy Library renders as a full-screen React overlay.",
          ],
          targetFiles: [pageFile, styleFile, barrelFile],
          implementationNotes: ["Use existing overlay and Tabs patterns."],
          validationSteps: ["npm test -- policy-library"],
        },
      ],
      fileChangeContract: [pageFile, styleFile, barrelFile].map((target) => ({
        path: target,
        role: target.endsWith(".module.scss")
          ? ("config_required" as const)
          : ("runtime_required" as const),
        editable: true,
        rationale:
          "Ticket requires the Policy Library React UI; create this file from the inspected correspondence-template-studio template.",
        supportingEvidence: [
          "Jira acceptance criteria require Policy Library UI as a full-screen overlay with tabs.",
          "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          "src/core/design-system/components/tabs/tabs.tsx",
        ],
        allowedChanges: ["Create the ticket-backed Policy Library file."],
      })),
    });
    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "React-based-new-ui",
      jiraKey: "CPDEV-25090",
      ticketSummary:
        "Policy Library - Policy Library Admin Menu Integration",
      taskDescription:
        "The Policy Library UI opens as a new React-based interface overlaying the legacy GWT interface. The Policy Library UI should display three tabs: Upload, Pending Review, Approved. The Upload tab should be the default landing tab.",
      qualificationSummary: {
        qualified: true,
        acceptanceCriteriaPresent: true,
        repoInspectionPerformed: true,
        inspectedFiles: [
          "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.module.scss",
          "src/document-ai/pages/correspondence-template-studio/index.ts",
          "src/core/design-system/components/tabs/tabs.tsx",
          "src/document-ai/pages/document-ai-layout.tsx",
          "src/core/routes/index.ts",
        ],
        inspectionSummary:
          "Inspected sibling overlay page, tabs, layout, route, and SCSS module evidence for Policy Library.",
        requirementsSummary: [
          "Policy Library overlay displays three tabs using SmartProminence UI theme.",
        ],
      },
    });
    const groundingPrompt = formatPlannerGroundingForPrompt(grounding);

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(groundingPrompt).toContain(
      "**Ticket-backed frontend feature candidates**:",
    );
    expect(groundingPrompt).toContain("Policy Library");
    expect(groundingPrompt).toContain("slug: `policy-library`");
    expect(groundingPrompt).toContain(
      "New frontend UI/API files are allowed only",
    );
    expect(validation.ok).toBe(true);
    for (const targetFile of [pageFile, styleFile, barrelFile]) {
      expect(validation.decisions).toContainEqual(
        expect.objectContaining({
          targetFile,
          kind: "ticket_template_backed_new_ui_target",
          ok: true,
          rationalePresent: true,
        }),
      );
    }
  });

  it("accepts run-644 shaped ticket-backed new frontend feature, API, and colocated tests", async () => {
    await writeFile(
      "src/core/design-system/components/file-upload/file-upload.tsx",
      "export function FileUpload() { return null; }\n",
    );
    await writeFile(
      "src/core/design-system/components/file-upload-modal/file-upload-modal.tsx",
      "export function FileUploadModal() { return <FileUpload />; }\n",
    );
    await writeFile(
      "src/core/design-system/components/file-upload-modal/file-upload-service.ts",
      "export function validateFile() { return true; }\n",
    );
    await writeFile(
      "src/core/design-system/components/file-upload-modal/file-upload-modal.test.tsx",
      "test('file upload modal', () => {});\n",
    );
    await writeFile(
      "src/core/api/file/file-api.ts",
      "export const fileApi = { uploadAndCreateIntake: 'multipart FormData upload' };\n",
    );
    await writeFile(
      "src/core/api/correspondence-template/slice.ts",
      "export const correspondenceTemplateApi = { reducerPath: 'correspondenceTemplateApi' };\n",
    );
    await writeFile(
      "src/core/api/correspondence-template/types.ts",
      "export interface CorrespondenceTemplateResponse {}\n",
    );
    await writeFile(
      "src/core/api/correspondence-template/index.ts",
      "export * from './slice';\n",
    );
    await writeFile(
      "src/app/store.ts",
      "export const store = { reducer: {}, middleware: [] };\n",
    );
    await writeFile(
      "src/core/routes/index.ts",
      "export enum RoutePath { SmartProminenceInsights = '/smart-prominence-insights' }\n",
    );
    await writeFile(
      "src/app/router.tsx",
      "export function Router() { return null; }\n",
    );

    const uiTargets = [
      "src/policy-library/policy-library-page.tsx",
      "src/policy-library/policy-library-page.module.scss",
      "src/policy-library/index.ts",
      "src/policy-library/components/policy-upload-tab/policy-upload-tab.tsx",
      "src/policy-library/components/policy-upload-tab/policy-upload-tab.module.scss",
      "src/policy-library/components/policy-upload-tab/policy-upload-validation.ts",
      "src/policy-library/components/policy-upload-tab/index.ts",
    ];
    const apiTargets = [
      "src/core/api/policy-library/slice.ts",
      "src/core/api/policy-library/types.ts",
      "src/core/api/policy-library/index.ts",
    ];
    const testTargets = [
      "src/policy-library/components/policy-upload-tab/policy-upload-validation.test.ts",
      "src/policy-library/components/policy-upload-tab/policy-upload-tab.test.tsx",
    ];
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary:
        "Implement Policy Library Upload tab for new policy uploads.",
      specs: [
        {
          id: "policy-library-upload",
          objective:
            "Create Policy Library upload UI, API slice, validation helper, and tests.",
          acceptanceCriteria: [
            "Policy Library Upload tab supports New policy uploads.",
          ],
          targetFiles: [...uiTargets, ...apiTargets, ...testTargets],
          implementationNotes: ["Reuse existing upload and API patterns."],
          validationSteps: ["npm test -- policy-upload"],
        },
      ],
      fileChangeContract: [
        ...uiTargets.map((target) => ({
          path: target,
          role: target.endsWith(".module.scss")
            ? ("config_required" as const)
            : ("runtime_required" as const),
          editable: true,
          rationale:
            "Ticket requires Policy Library Upload tab UI using existing SmartProminence upload components.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library upload UI with drag-and-drop, Policy Name, accepted file types, and max file size.",
            "src/core/design-system/components/file-upload/file-upload.tsx",
            "src/core/design-system/components/file-upload-modal/file-upload-modal.tsx",
          ],
          allowedChanges: ["Create the ticket-backed Policy Library UI file."],
        })),
        ...apiTargets.map((target) => ({
          path: target,
          role: "runtime_required" as const,
          editable: true,
          rationale:
            "Ticket requires upload configuration, policy-name uniqueness validation, metadata capture, and upload processing for Policy Library.",
          supportingEvidence: [
            "Jira acceptance criteria require backend IT configuration, uniqueness validation, and upload metadata.",
            "src/core/api/file/file-api.ts",
            "src/core/api/correspondence-template/slice.ts",
          ],
          allowedChanges: ["Create the ticket-backed Policy Library API file."],
        })),
        ...testTargets.map((target) => ({
          path: target,
          role: "test_required" as const,
          editable: true,
          rationale:
            "New colocated test covers the accepted Policy Library upload source target.",
          supportingEvidence: [
            target.endsWith("validation.test.ts")
              ? "src/policy-library/components/policy-upload-tab/policy-upload-validation.ts"
              : "src/policy-library/components/policy-upload-tab/policy-upload-tab.tsx",
          ],
          allowedChanges: ["Create colocated Policy Library upload tests."],
        })),
      ],
    });
    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "React-based-new-ui",
      jiraKey: "CPDEV-24554",
      ticketSummary: "Policy Library - Policy Upload Functionality (New)",
      taskDescription:
        "Add policy document upload functionality to the Upload tab of Policy Library for new policy uploads. Use existing SmartProminence UI upload components. Display accepted file types and maximum file size from backend IT configuration. Validate blank Policy Name, duplicate policy name, unsupported file types, and files exceeding size limit. Store upload metadata and trigger AI extraction service.",
      qualificationSummary: {
        qualified: true,
        acceptanceCriteriaPresent: true,
        repoInspectionPerformed: true,
        inspectedFiles: [
          "src/core/design-system/components/file-upload/file-upload.tsx",
          "src/core/design-system/components/file-upload-modal/file-upload-modal.tsx",
          "src/core/design-system/components/file-upload-modal/file-upload-service.ts",
          "src/core/api/file/file-api.ts",
          "src/core/api/correspondence-template/slice.ts",
          "src/core/api/correspondence-template/types.ts",
          "src/core/api/correspondence-template/index.ts",
          "src/app/store.ts",
          "src/core/routes/index.ts",
          "src/app/router.tsx",
        ],
        inspectionSummary:
          "Inspected upload components, API slice/type/index templates, store registration, router, and route evidence for Policy Library Upload.",
        requirementsSummary: [
          "Implement file upload interface on the Upload tab of Policy Library in SmartProminence UI with drag-and-drop support using existing components.",
          "Add mandatory Policy Name field with uniqueness validation and backend-configured file type and size validation.",
        ],
      },
    });

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    for (const targetFile of uiTargets) {
      expect(validation.decisions).toContainEqual(
        expect.objectContaining({
          targetFile,
          kind: "ticket_template_backed_new_ui_target",
          ok: true,
        }),
      );
    }
    for (const targetFile of apiTargets) {
      expect(validation.decisions).toContainEqual(
        expect.objectContaining({
          targetFile,
          kind: "ticket_template_backed_new_api_target",
          ok: true,
        }),
      );
    }
    for (const targetFile of testTargets) {
      expect(validation.decisions).toContainEqual(
        expect.objectContaining({
          targetFile,
          ok: true,
        }),
      );
    }
  });

  it("rejects ticket-like frontend targets when the feature slug is not ticket-backed", async () => {
    const targetFile = "src/random-admin/random-admin-page.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-25090",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create unrelated page.",
      specs: [
        {
          id: "unrelated-page",
          objective: "Create an unrelated page.",
          acceptanceCriteria: ["Unrelated page is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be ticket-backed."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "runtime_required",
          editable: true,
          rationale:
            "Ticket requires Policy Library, but this target is random admin.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library.",
            "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          ],
          allowedChanges: ["Create unrelated page."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-07-01T12:00:00.000Z",
      jiraKey: "CPDEV-25090",
      repoName: "React-based-new-ui",
      confidence: "strong" as const,
      terms: [{ value: "PolicyLibrary", kind: "identifier" as const, weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["PolicyLibrary"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          line: 1,
          term: "PolicyLibrary",
          text: "export function CorrespondenceTemplateStudioPage() {}",
        },
      ],
      sourceTestPairs: [],
      frontendFeatureCandidates: [
        {
          label: "Policy Library",
          slug: "policy-library",
          sources: ["ticket summary"],
          apiIntent: false,
        },
      ],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(targetFile);
  });

  it("rejects shared component paths that merely contain a ticket-backed slug segment", async () => {
    const targetFile = "src/shared/components/policy-library/policy-card.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create shared Policy Library component.",
      specs: [
        {
          id: "shared-component",
          objective: "Create a shared component outside the feature root.",
          acceptanceCriteria: ["Shared component path is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be accepted."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "runtime_required",
          editable: true,
          rationale: "Ticket requires Policy Library UI.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library UI.",
            "src/core/design-system/components/tabs/tabs.tsx",
          ],
          allowedChanges: ["Create shared component."],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, {
      generatedAt: "2026-07-01T12:00:00.000Z",
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      confidence: "strong",
      terms: [{ value: "PolicyLibrary", kind: "identifier", weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/core/design-system/components/tabs/tabs.tsx",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["PolicyLibrary"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/core/design-system/components/tabs/tabs.tsx",
          line: 1,
          term: "PolicyLibrary",
          text: "export function PolicyLibraryTabs() {}",
        },
      ],
      sourceTestPairs: [],
      frontendFeatureCandidates: [
        {
          label: "Policy Library",
          slug: "policy-library",
          sources: ["ticket summary"],
          apiIntent: false,
        },
      ],
      riskFiles: [],
      warnings: [],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "target is not exact evidence and is not an allowed adjacent source",
    );
  });

  it("rejects new API targets when the ticket does not contain API or backend intent", async () => {
    const targetFile = "src/core/api/policy-library/slice.ts";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-25090",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create API without ticket API intent.",
      specs: [
        {
          id: "api-target",
          objective: "Create an API target without ticket API evidence.",
          acceptanceCriteria: ["API target is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be accepted."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "runtime_required",
          editable: true,
          rationale:
            "Ticket requires Policy Library React UI, but does not require API behavior.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library UI.",
            "src/core/api/correspondence-template/slice.ts",
          ],
          allowedChanges: ["Create API target."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-07-01T12:00:00.000Z",
      jiraKey: "CPDEV-25090",
      repoName: "React-based-new-ui",
      confidence: "strong" as const,
      terms: [{ value: "PolicyLibrary", kind: "identifier" as const, weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/core/api/correspondence-template/slice.ts",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["PolicyLibrary"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/core/api/correspondence-template/slice.ts",
          line: 1,
          term: "PolicyLibrary",
          text: "export const correspondenceTemplateApi = {};",
        },
      ],
      sourceTestPairs: [],
      frontendFeatureCandidates: [
        {
          label: "Policy Library",
          slug: "policy-library",
          sources: ["ticket summary"],
          apiIntent: false,
        },
      ],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "ticket-backed API target requires ticket API/backend/upload/config intent",
    );
  });

  it("does not treat frontend-only validation wording as API intent", async () => {
    await writeFile(
      "src/core/api/correspondence-template/slice.ts",
      "export const correspondenceTemplateApi = { reducerPath: 'correspondenceTemplateApi' };\n",
    );

    const targetFile = "src/core/api/policy-library/slice.ts";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-25090",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create API from frontend validation wording.",
      specs: [
        {
          id: "frontend-validation-api-target",
          objective: "Create an API target from UI validation wording.",
          acceptanceCriteria: ["Frontend-only validation is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be accepted."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "runtime_required",
          editable: true,
          rationale:
            "Ticket requires Policy Library UI validation, but no server work.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library UI validation.",
            "src/core/api/correspondence-template/slice.ts",
          ],
          allowedChanges: ["Create API target."],
        },
      ],
    });
    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "React-based-new-ui",
      jiraKey: "CPDEV-25090",
      ticketSummary: "Policy Library UI Validation",
      taskDescription:
        "Add Policy Library UI validation for required fields before allowing the form to continue.",
      qualificationSummary: {
        qualified: true,
        acceptanceCriteriaPresent: true,
        repoInspectionPerformed: true,
        inspectedFiles: ["src/core/api/correspondence-template/slice.ts"],
        inspectionSummary:
          "Inspected existing API slice only as a repo template.",
        requirementsSummary: [
          "Policy Library UI validation should show required field messages.",
        ],
      },
    });

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "ticket-backed API target requires ticket API/backend/upload/config intent",
    );
  });

  it("rejects generated or global frontend style targets even with a ticket-backed slug", async () => {
    const targetFile = "src/policy-library/global.css";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create Policy Library global CSS.",
      specs: [
        {
          id: "global-style",
          objective: "Create a global style target.",
          acceptanceCriteria: ["Global style target is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be accepted."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "config_required",
          editable: true,
          rationale: "Ticket requires Policy Library UI.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library UI.",
            "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          ],
          allowedChanges: ["Create global style."],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, {
      generatedAt: "2026-07-01T12:00:00.000Z",
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      confidence: "strong",
      terms: [{ value: "PolicyLibrary", kind: "identifier", weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["PolicyLibrary"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          line: 1,
          term: "PolicyLibrary",
          text: "export function PolicyLibraryTemplate() {}",
        },
      ],
      sourceTestPairs: [],
      frontendFeatureCandidates: [
        {
          label: "Policy Library",
          slug: "policy-library",
          sources: ["ticket summary"],
          apiIntent: false,
        },
      ],
      riskFiles: [],
      warnings: [],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "generated or global style file",
    );
  });

  it("rejects ticket-backed frontend targets without editable fileChangeContract evidence", async () => {
    const targetFile = "src/policy-library/policy-library-page.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create Policy Library page without a contract.",
      specs: [
        {
          id: "missing-contract",
          objective: "Create Policy Library page.",
          acceptanceCriteria: ["Missing contract is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be accepted."],
          validationSteps: ["npm test"],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, {
      generatedAt: "2026-07-01T12:00:00.000Z",
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      confidence: "strong",
      terms: [{ value: "PolicyLibrary", kind: "identifier", weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["PolicyLibrary"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/document-ai/pages/correspondence-template-studio/correspondence-template-studio-page.tsx",
          line: 1,
          term: "PolicyLibrary",
          text: "export function PolicyLibraryTemplate() {}",
        },
      ],
      sourceTestPairs: [],
      frontendFeatureCandidates: [
        {
          label: "Policy Library",
          slug: "policy-library",
          sources: ["ticket summary"],
          apiIntent: false,
        },
      ],
      riskFiles: [],
      warnings: [],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "adjacent target requires fileChangeContract evidence",
    );
  });

  it("rejects ticket-backed frontend targets when only Jira text is grounded", async () => {
    const targetFile = "src/policy-library/policy-library-page.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create Policy Library page without template evidence.",
      specs: [
        {
          id: "jira-only",
          objective: "Create Policy Library page.",
          acceptanceCriteria: ["Jira-only evidence is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Should not be accepted."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "runtime_required",
          editable: true,
          rationale: "Ticket requires Policy Library UI.",
          supportingEvidence: [
            "Jira acceptance criteria require Policy Library UI.",
          ],
          allowedChanges: ["Create ticket-backed page."],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, {
      generatedAt: "2026-07-01T12:00:00.000Z",
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      confidence: "strong",
      terms: [{ value: "PolicyLibrary", kind: "identifier", weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "docs/policy-library.md",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["PolicyLibrary"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "docs/policy-library.md",
          line: 1,
          term: "PolicyLibrary",
          text: "PolicyLibrary ticket acceptance criteria.",
        },
      ],
      sourceTestPairs: [],
      frontendFeatureCandidates: [
        {
          label: "Policy Library",
          slug: "policy-library",
          sources: ["ticket summary"],
          apiIntent: false,
        },
      ],
      riskFiles: [],
      warnings: [],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "inspected repo UI template evidence",
    );
  });

  it("extracts ticket-explicit new Java source candidates from ticket evidence", async () => {
    await writeFile(RUN_605_MODULE_EVIDENCE, "class CodesMasterService {}\n");

    const grounding = await buildPlannerGroundingContext({
      workspacePath,
      repoName: "core-app",
      jiraKey: "CPDEV-25292",
      ticketSummary: "Code classifier event publication",
      taskDescription: "Legacy task description fallback.",
      qualificationSummary: {
        requirementsSummary: ["Create code classifier event classes."],
      },
      ticketEvidence: {
        schemaVersion: "ticket-evidence.v1",
        jiraKey: "CPDEV-25292",
        capturedAt: "2026-07-01T12:00:00.000Z",
        issue: {
          summary: "Code classifier event publication",
          issueType: "Story",
          labels: ["PFOS"],
        },
        descriptionMarkdown: [
          "Create CodeClassifierConfigChangedEvent.java.",
          "package com.medhok.mm.server.event;",
          "Use @Async @EventListener for code classifier saves.",
        ].join("\n"),
        comments: [
          {
            id: "10001",
            author: "PRISM",
            created: "2026-07-01T12:05:00.000Z",
            bodyMarkdown:
              "Add class CodesMasterSavedEvent in package com.medhok.mm.server.event.",
          },
        ],
        attachments: [],
        warnings: [],
        stats: {
          commentCount: 1,
          attachmentCount: 0,
          extractedAttachmentCount: 0,
          imageAttachmentCount: 0,
          warningCount: 0,
        },
      },
    } as any);

    expect(
      (grounding as any).ticketExplicitNewSourceCandidates,
    ).toContainEqual(
      expect.objectContaining({
        className: "CodeClassifierConfigChangedEvent",
        fileName: "CodeClassifierConfigChangedEvent.java",
        packageName: RUN_605_EVENT_PACKAGE,
        sources: expect.arrayContaining(["ticket_description"]),
      }),
    );
    expect(
      (grounding as any).ticketExplicitNewSourceCandidates,
    ).toContainEqual(
      expect.objectContaining({
        className: "CodesMasterSavedEvent",
        fileName: "CodesMasterSavedEvent.java",
        packageName: RUN_605_EVENT_PACKAGE,
        sources: expect.arrayContaining(["ticket_comment:10001"]),
      }),
    );
    const prompt = formatPlannerGroundingForPrompt(grounding);
    expect(prompt).toContain("**Ticket-Explicit New Java Sources**");
    expect(prompt).toContain("CodeClassifierConfigChangedEvent.java");
    expect(prompt).toContain(
      "fileChangeContract cites both ticket evidence and repo-backed module evidence",
    );
  });

  it("accepts run-605 shaped ticket-explicit new Java source targets with repo module evidence", () => {
    const validation = validatePlanAgainstGrounding(
      run605Plan(),
      run605Grounding() as any,
    );

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: RUN_605_EVENT_TARGET,
        kind: "ticket_explicit_new_source",
        ok: true,
        supportingFiles: [RUN_605_MODULE_EVIDENCE],
        evidenceSource: "file_change_contract_evidence",
        rationaleRequired: true,
        rationalePresent: true,
      }),
    );
  });

  it("accepts ticket-explicit Java source targets in a repo-root src/main/java module", () => {
    const targetFile =
      "src/main/java/com/example/event/CodeClassifierConfigChangedEvent.java";
    const moduleEvidence =
      "src/main/java/com/example/service/CodesMasterService.java";
    const grounding = {
      ...run605Grounding(),
      candidateFiles: [
        {
          path: moduleEvidence,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["CodesMasterService"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: moduleEvidence,
          line: 42,
          term: "CodesMasterService",
          text: "public class CodesMasterService saves code classifier updates",
        },
      ],
      ticketExplicitNewSourceCandidates: [
        {
          className: "CodeClassifierConfigChangedEvent",
          fileName: "CodeClassifierConfigChangedEvent.java",
          packageName: "com.example.event",
          sources: ["ticket_description"],
          evidenceText:
            "Create class CodeClassifierConfigChangedEvent.java in package com.example.event",
        },
      ],
    };
    const validation = validatePlanAgainstGrounding(
      run605Plan(targetFile, [
        "Ticket evidence names CodeClassifierConfigChangedEvent.java in package com.example.event.",
        `Read ${moduleEvidence} for the affected code classifier save surface.`,
      ]),
      grounding as any,
    );

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "ticket_explicit_new_source",
        ok: true,
        supportingFiles: [moduleEvidence],
      }),
    );
  });

  it("rejects ticket-explicit Java source when the ticket did not name the class", () => {
    const grounding = {
      ...run605Grounding(),
      ticketExplicitNewSourceCandidates: [
        {
          className: "CodesMasterSavedEvent",
          fileName: "CodesMasterSavedEvent.java",
          packageName: RUN_605_EVENT_PACKAGE,
          sources: ["ticket_description"],
          evidenceText:
            "Create class CodesMasterSavedEvent.java in package com.medhok.mm.server.event",
        },
      ],
    };

    const validation = validatePlanAgainstGrounding(
      run605Plan(),
      grounding as any,
    );

    expect(validation.ok).toBe(false);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: RUN_605_EVENT_TARGET,
        kind: "ticket_explicit_new_source",
        ok: false,
        reason: expect.stringContaining(
          "ticket evidence did not name CodeClassifierConfigChangedEvent.java",
        ),
      }),
    );
  });

  it("rejects ticket-explicit Java source when the ticket package does not match the target", () => {
    const grounding = {
      ...run605Grounding(),
      ticketExplicitNewSourceCandidates: [
        {
          className: "CodeClassifierConfigChangedEvent",
          fileName: "CodeClassifierConfigChangedEvent.java",
          packageName: "com.medhok.mm.server.other",
          sources: ["ticket_description"],
          evidenceText:
            "Create class CodeClassifierConfigChangedEvent.java in package com.medhok.mm.server.other",
        },
      ],
    };

    const validation = validatePlanAgainstGrounding(
      run605Plan(),
      grounding as any,
    );

    expect(validation.ok).toBe(false);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: RUN_605_EVENT_TARGET,
        kind: "ticket_explicit_new_source",
        ok: false,
        reason: expect.stringContaining(
          "ticket evidence package does not match target package",
        ),
      }),
    );
  });

  it("rejects ticket-explicit Java source when the ticket path does not match the target", () => {
    const grounding = {
      ...run605Grounding(),
      ticketExplicitNewSourceCandidates: [
        {
          className: "CodeClassifierConfigChangedEvent",
          fileName: "CodeClassifierConfigChangedEvent.java",
          packageName: "com.medhok.mm.server.other",
          path: "MedicalMgmt/src/main/java/com/medhok/mm/server/other/CodeClassifierConfigChangedEvent.java",
          sources: ["ticket_description"],
          evidenceText:
            "Create MedicalMgmt/src/main/java/com/medhok/mm/server/other/CodeClassifierConfigChangedEvent.java",
        },
      ],
    };

    const validation = validatePlanAgainstGrounding(
      run605Plan(),
      grounding as any,
    );

    expect(validation.ok).toBe(false);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: RUN_605_EVENT_TARGET,
        kind: "ticket_explicit_new_source",
        ok: false,
        reason: expect.stringContaining(
          "ticket evidence path does not match target path",
        ),
      }),
    );
  });

  it("rejects ticket-explicit Java source without editable fileChangeContract evidence", () => {
    const plan = parseOneShotPlan({
      ...run605Plan(),
      fileChangeContract: [
        {
          path: RUN_605_EVENT_TARGET,
          role: "read_only_evidence",
          editable: false,
          rationale: "Read-only should not pass.",
          supportingEvidence: [
            "Ticket evidence names CodeClassifierConfigChangedEvent.java.",
            `Read ${RUN_605_MODULE_EVIDENCE}.`,
          ],
          allowedChanges: [],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(
      plan,
      run605Grounding() as any,
    );

    expect(validation.ok).toBe(false);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: RUN_605_EVENT_TARGET,
        kind: "ticket_explicit_new_source",
        ok: false,
        reason: expect.stringContaining(
          "fileChangeContract marks ticket-explicit target as non-editable",
        ),
      }),
    );
  });

  it("rejects ticket-explicit Java source that cites Jira but no repo module evidence", () => {
    const validation = validatePlanAgainstGrounding(
      run605Plan(RUN_605_EVENT_TARGET, [
        "Ticket evidence names CodeClassifierConfigChangedEvent.java in package com.medhok.mm.server.event.",
      ]),
      run605Grounding() as any,
    );

    expect(validation.ok).toBe(false);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: RUN_605_EVENT_TARGET,
        kind: "ticket_explicit_new_source",
        ok: false,
        reason: expect.stringContaining(
          "fileChangeContract supportingEvidence must reference repo-backed module evidence",
        ),
      }),
    );
  });

  it("accepts target files backed by qualification-inspected files", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Style cancel button",
      specs: [
        {
          id: "style-cancel",
          objective: "Style the Member Search cancel button.",
          acceptanceCriteria: ["Cancel button is red."],
          targetFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          ],
          implementationNotes: ["Use qualifier inspection evidence."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      confidence: "strong",
      terms: [],
      routeCards: [],
      candidateFiles: [],
      snippets: [],
      sourceTestPairs: [],
      qualificationEvidence: {
        trusted: true,
        verifiedInspectedFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        ],
        inspectionSummary: "Confirmed MemberSearchForm.java and line numbers.",
        reasons: [],
      },
      riskFiles: [],
      warnings: [],
    });

    expect(validation.ok).toBe(true);
  });

  it("accepts target files backed only by scout-inspected files", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Fix queue routing",
      specs: [
        {
          id: "queue-routing",
          objective: "Fix approval queue routing.",
          acceptanceCriteria: ["Approvals route to the expected queue."],
          targetFiles: ["src/ApprovalQueue.ts"],
          implementationNotes: ["Use scout evidence."],
          validationSteps: ["npm test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      confidence: "weak" as const,
      terms: [],
      routeCards: [],
      candidateFiles: [],
      snippets: [],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };
    const evidence = buildPlannerEvidenceContext({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      grounding,
      scoutStatus: "scouts_supported_plan",
      scoutReports: [
        {
          workItemId: "scout-1",
          objective: "Fix approval queue routing.",
          status: "valid",
          inspectedFiles: ["src/ApprovalQueue.ts"],
          verifiedInspectedFiles: ["src/ApprovalQueue.ts"],
          snippets: [],
          symbols: ["ApprovalQueue"],
          testFiles: [],
          commands: ["npm test"],
          confidence: "strong",
          blockers: [],
          toolCalls: 2,
          durationMs: 1000,
        },
      ],
    });

    const validation = validatePlanAgainstGrounding(plan, grounding, evidence);
    const enrichedPlan = applyGroundingToPlan(plan, grounding, evidence);

    expect(evidence.confidence).toBe("strong");
    expect(isPlannerEvidenceStrong(evidence)).toBe(true);
    expect(validation.ok).toBe(true);
    expect(enrichedPlan.plannerDiscoveries?.entryPoints).toContain(
      "src/ApprovalQueue.ts",
    );
  });

  it("does not treat test-surface-only scout evidence as strong grounding", () => {
    const evidence = buildPlannerEvidenceContext({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      scoutStatus: "scouts_supported_plan",
      scoutReports: [
        {
          workItemId: "test-surface",
          objective: "Find adjacent tests.",
          status: "valid",
          inspectedFiles: ["src/ApprovalQueue.test.ts"],
          verifiedInspectedFiles: ["src/ApprovalQueue.test.ts"],
          snippets: [],
          symbols: ["ApprovalQueue regression"],
          testFiles: ["src/ApprovalQueue.test.ts"],
          commands: ["npm test -- ApprovalQueue"],
          confidence: "strong",
          blockers: [],
          toolCalls: 2,
          durationMs: 1000,
        },
      ],
    });

    expect(evidence.confidence).toBe("weak");
    expect(isPlannerEvidenceStrong(evidence)).toBe(false);
  });

  it("does not treat template-only scout evidence as strong grounding", () => {
    const evidence = buildPlannerEvidenceContext({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      scoutStatus: "scouts_supported_plan",
      scoutReports: [
        {
          workItemId: "template-patterns",
          objective: "Find source parity templates.",
          status: "valid",
          inspectedFiles: ["src/ExistingWorkflow.ts"],
          verifiedInspectedFiles: ["src/ExistingWorkflow.ts"],
          snippets: [
            {
              file: "src/ExistingWorkflow.ts",
              line: 12,
              term: "ExistingWorkflow",
              text: "export class ExistingWorkflow {}",
            },
          ],
          symbols: ["ExistingWorkflow"],
          testFiles: [],
          commands: [],
          templateMappings: [
            {
              targetPattern: "new workflow",
              templateFile: "src/ExistingWorkflow.ts",
              rationale: "Match source parity pattern.",
            },
          ],
          confidence: "strong",
          blockers: [],
          toolCalls: 2,
          durationMs: 1000,
        },
      ],
    });

    expect(evidence.confidence).toBe("weak");
    expect(isPlannerEvidenceStrong(evidence)).toBe(false);
  });

  it("formats rich scout evidence for the main planner", () => {
    const evidence = buildPlannerEvidenceContext({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      scoutStatus: "scouts_supported_plan",
      scoutReports: [
        {
          workItemId: "runtime-and-tests",
          objective: "Find runtime and tests.",
          status: "valid",
          inspectedFiles: ["src/Workflow.ts", "src/Workflow.test.ts"],
          verifiedInspectedFiles: ["src/Workflow.ts", "src/Workflow.test.ts"],
          snippets: [
            {
              file: "src/Workflow.ts",
              line: 7,
              term: "Workflow",
              text: "export function updateWorkflow()",
            },
          ],
          symbols: ["updateWorkflow", "WorkflowState"],
          testFiles: ["src/Workflow.test.ts"],
          commands: ["npm test -- Workflow"],
          templateMappings: [
            {
              targetPattern: "new workflow case",
              templateFile: "src/ExistingWorkflow.ts",
              rationale: "Follow existing workflow pattern.",
            },
          ],
          confidence: "strong",
          blockers: ["source parity must be checked"],
          toolCalls: 3,
          durationMs: 1000,
        },
      ],
    });

    const prompt = formatPlannerEvidenceForPrompt(evidence);

    expect(prompt).toContain("symbols: updateWorkflow, WorkflowState");
    expect(prompt).toContain("tests: `src/Workflow.test.ts`");
    expect(prompt).toContain("advisory validation commands: advisory: npm test -- Workflow");
    expect(prompt).toContain("risks/gaps: source parity must be checked");
    expect(prompt).toContain("template mappings: new workflow case from src/ExistingWorkflow.ts");
  });

  it("formats no-work scout diagnostics as advisory evidence for the main planner", () => {
    const evidence = buildPlannerEvidenceContext({
      jiraKey: "CPDEV-21972",
      repoName: "core-app",
      scoutStatus: "scouts_no_work_items",
      scoutReports: [],
      scoutCoverage: {
        requirementCount: 1,
        evidenceBackedRequirementCount: 1,
        uncoveredRequirementCount: 0,
      },
      scoutInvocationFailed: false,
      scoutReturnedNothing: false,
      warnings: ["No uncovered requirements were available for scout fallback."],
    });

    const prompt = formatPlannerEvidenceForPrompt(evidence);

    expect(prompt).toContain(
      "Planner Scout had no uncovered work because requirements were already backed by existing evidence.",
    );
    expect(prompt).toContain("Scout requirements: 1");
    expect(prompt).toContain("Scout uncovered requirements: 0");
    expect(prompt).toContain("Scout invocation failed: no");
  });

  it("accepts exact final-planner read files as target evidence", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Use final planner read evidence.",
      specs: [
        {
          id: "task-linkage",
          objective: "Update existing user session mapping.",
          acceptanceCriteria: ["Mapping supports task linkage."],
          targetFiles: [
            "MedicalMgmtModels/src/main/resources/applicationHibernateMapping.xml",
          ],
          implementationNotes: ["Final planner read this file."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "UserSessionAction", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["UserSessionAction"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          line: 20,
          term: "UserSessionAction",
          text: "class UserSessionAction tracks session actions",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(
      plan,
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "MedicalMgmtModels/src/main/resources/applicationHibernateMapping.xml",
        ],
      },
    );

    expect(validation.ok).toBe(true);
  });

  it("accepts new adjacent source, mapping, migration, and matching test targets", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create task lifecycle tracking.",
      specs: [
        {
          id: "task-lifecycle",
          objective: "Create adjacent lifecycle files.",
          acceptanceCriteria: ["Lifecycle events are persisted and queryable."],
          targetFiles: [
            "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/TaskLifecycleEvent.java",
            "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/TaskLifecycleEvent.hbm.xml",
            "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/model/tasklifecycle/TaskLifecycleEventRequest.java",
            "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/TaskLifecycleController.java",
            "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/TaskLifecycleService.java",
            "mm-shared-services/src/test/java/com/medhok/mm/server/businessservice/TaskLifecycleServiceTest.java",
            "flyway/sql/V1.2026-04-27-01__task_lifecycle_event.sql",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/TaskLifecycleEvent.java",
              rationale:
                "Existing UserSessionAction model establishes the adjacent lifecycle model pattern.",
              supportingFiles: [
                "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
              ],
            },
            {
              targetFile:
                "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/TaskLifecycleEvent.hbm.xml",
              rationale:
                "Existing UserSessionAction mapping establishes the adjacent mapping pattern.",
              supportingFiles: [
                "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/UserSessionAction.hbm.xml",
              ],
            },
            {
              targetFile:
                "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/model/tasklifecycle/TaskLifecycleEventRequest.java",
              rationale:
                "Existing BFF controller evidence anchors the adjacent BFF module.",
              supportingFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/UserActivityController.java",
              ],
            },
            {
              targetFile:
                "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/TaskLifecycleController.java",
              rationale:
                "Existing UserActivityController establishes the controller pattern.",
              supportingFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/UserActivityController.java",
              ],
            },
            {
              targetFile:
                "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/TaskLifecycleService.java",
              rationale:
                "Existing WorkflowBusinessService establishes the shared-service pattern.",
              supportingFiles: [
                "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/WorkflowBusinessService.java",
              ],
            },
            {
              targetFile:
                "flyway/sql/V1.2026-04-27-01__task_lifecycle_event.sql",
              rationale:
                "Existing Flyway migration establishes the adjacent migration directory and filename pattern.",
              supportingFiles: [
                "flyway/sql/V1.2025-02-25-72__user_session.sql",
              ],
            },
          ],
          implementationNotes: [
            "Use adjacent model, service, mapping, test, and migration patterns.",
          ],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "UserSessionAction", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["UserSessionAction"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          line: 20,
          term: "UserSessionAction",
          text: "class UserSessionAction tracks session actions",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(
      plan,
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/UserSessionAction.hbm.xml",
          "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/UserActivityController.java",
          "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/WorkflowBusinessService.java",
          "flyway/sql/V1.2025-02-25-72__user_session.sql",
        ],
      },
    );

    expect(validation.ok).toBe(true);
  });

  it("accepts adjacent source Sass targets backed by same-directory style evidence and rationale", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
              rationale:
                "Existing custom button Sass partials establish the adjacent source style pattern.",
              supportingFiles: [
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
              ],
              rejectedAlternatives: [
                "Do not edit generated skin_styles.css directly.",
              ],
            },
          ],
          implementationNotes: [
            "Follow the existing custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          line: 1,
          term: "cancelButton",
          text: ".csPrimaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [
        "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
      ],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile:
          "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
        kind: "adjacent_style_asset",
        ok: true,
        rationaleRequired: true,
        rationalePresent: true,
      }),
    );
  });

  it("accepts adjacent source Sass targets from canonical fileChangeContract evidence", async () => {
    const targetFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss";
    const supportFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [targetFile],
          implementationNotes: [
            "Follow the inspected custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "source_parity",
          editable: true,
          rationale:
            "New source-parity Sass partial modeled on the inspected sibling button style.",
          supportingEvidence: [
            `Read ${supportFile} as the same-directory button style template.`,
          ],
          allowedChanges: ["Create the new Sass partial."],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "cancelButton",
          text: ".csSecondaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [supportFile],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "adjacent_style_asset",
        ok: true,
        evidenceSource: "file_change_contract_evidence",
        rationaleRequired: true,
        rationalePresent: true,
      }),
    );
  });

  it("accepts unique basename support from fileChangeContract evidence", async () => {
    const targetFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss";
    const supportFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [targetFile],
          implementationNotes: [
            "Follow the inspected custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "source_parity",
          editable: true,
          rationale:
            "New source-parity Sass partial modeled on _csSecondaryButton.scss.",
          supportingEvidence: [
            "Read _csSecondaryButton.scss as the unique same-directory template.",
          ],
          allowedChanges: ["Create the new Sass partial."],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "cancelButton",
          text: ".csSecondaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [supportFile],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        ok: true,
        evidenceSource: "file_change_contract_evidence",
      }),
    );
  });

  it("rejects vague fileChangeContract evidence for adjacent source Sass targets", async () => {
    const targetFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss";
    const supportFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [targetFile],
          implementationNotes: [
            "Follow the inspected custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "source_parity",
          editable: true,
          rationale: "New source-parity Sass partial modeled on a sibling.",
          supportingEvidence: ["Read a similar sibling style file."],
          allowedChanges: [
            `Create the new Sass partial following ${supportFile}.`,
          ],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "cancelButton",
          text: ".csSecondaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [supportFile],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "fileChangeContract supportingEvidence must reference an adjacency-supporting evidence file",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        ok: false,
        evidenceSource: "file_change_contract_evidence",
      }),
    );
  });

  it("lets fileChangeContract non-editable scope override legacy targetFileRationales", async () => {
    const targetFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss";
    const supportFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [targetFile],
          targetFileRationales: [
            {
              targetFile,
              rationale:
                "Existing custom button Sass partial establishes the adjacent source style pattern.",
              supportingFiles: [supportFile],
            },
          ],
          implementationNotes: [
            "Follow the inspected custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "read_only_evidence",
          editable: false,
          rationale:
            "Incorrectly marked read-only despite being a planned target.",
          supportingEvidence: [`Read ${supportFile} as the template.`],
          allowedChanges: [],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "cancelButton",
          text: ".csSecondaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [supportFile],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "fileChangeContract marks adjacent target as non-editable or read-only",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        ok: false,
        evidenceSource: "contract_marks_target_non_editable",
        rationalePresent: true,
      }),
    );
  });

  it("accepts new UI asset targets backed by same-directory asset evidence and fileChangeContract proof", async () => {
    const targetFiles = [
      "src/core/design-system/icons/assets/action/fullscreen.svg",
      "src/core/design-system/icons/assets/action/fullscreen-exit.svg",
      "src/core/design-system/icons/logo-smart-prominence-inverted.svg",
    ];
    const supportFiles = [
      "src/core/design-system/icons/assets/action/expand-all.svg",
      "src/core/design-system/icons/assets/action/collapse-all.svg",
      "src/core/design-system/icons/smart_prominence_logo.png",
    ];
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add dialog fullscreen icon assets.",
      specs: [
        {
          id: "fullscreen-assets",
          objective: "Add adjacent design-system assets for fullscreen UX.",
          acceptanceCriteria: [
            "Fullscreen controls use source-backed icon assets.",
          ],
          targetFiles,
          implementationNotes: [
            "Follow existing design-system icon asset placement.",
          ],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFiles[0],
          role: "config_required",
          editable: true,
          rationale:
            "New fullscreen icon belongs beside inspected action icon assets.",
          supportingEvidence: [
            `Glob discovered ${supportFiles[0]} as the adjacent action icon template.`,
          ],
          allowedChanges: ["Create the fullscreen SVG asset."],
        },
        {
          path: targetFiles[1],
          role: "config_required",
          editable: true,
          rationale:
            "New fullscreen-exit icon belongs beside inspected action icon assets.",
          supportingEvidence: [
            `Glob discovered ${supportFiles[1]} as the adjacent action icon template.`,
          ],
          allowedChanges: ["Create the fullscreen-exit SVG asset."],
        },
        {
          path: targetFiles[2],
          role: "config_required",
          editable: true,
          rationale:
            "New inverted logo asset belongs beside the inspected smart prominence logo.",
          supportingEvidence: [
            `Glob discovered ${supportFiles[2]} as the adjacent logo template.`,
          ],
          allowedChanges: ["Create the inverted logo SVG asset."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-06-23T12:00:00.000Z",
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "fullscreen", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "src/core/design-system/icons/icon-map.ts",
          score: 30,
          reasons: ["content match", "design-system asset pattern"],
          matchedTerms: ["fullscreen"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "src/core/design-system/icons/icon-map.ts",
          line: 1,
          term: "fullscreen",
          text: "expand-all and collapse-all icons are registered",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding, undefined, {
      finalPlannerDiscoveredFiles: supportFiles,
    });

    expect(validation.ok).toBe(true);
    for (const targetFile of targetFiles) {
      expect(validation.decisions).toContainEqual(
        expect.objectContaining({
          targetFile,
          kind: "adjacent_ui_asset",
          ok: true,
          evidenceSource: "file_change_contract_evidence",
          rationaleRequired: true,
          rationalePresent: true,
        }),
      );
    }
  });

  it("accepts new UI asset targets backed by same-directory asset candidate evidence", async () => {
    const targetFile =
      "src/core/design-system/icons/assets/action/fullscreen.svg";
    const supportFile =
      "src/core/design-system/icons/assets/action/expand-all.svg";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add dialog fullscreen icon asset.",
      specs: [
        {
          id: "fullscreen-asset",
          objective: "Add adjacent design-system asset for fullscreen UX.",
          acceptanceCriteria: [
            "Fullscreen controls use a source-backed icon asset.",
          ],
          targetFiles: [targetFile],
          implementationNotes: [
            "Follow existing design-system icon asset placement.",
          ],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "config_required",
          editable: true,
          rationale:
            "New fullscreen icon belongs beside inspected action icon assets.",
          supportingEvidence: [
            `Read ${supportFile} as the adjacent action icon template.`,
          ],
          allowedChanges: ["Create the fullscreen SVG asset."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-06-23T12:00:00.000Z",
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "fullscreen", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match", "design-system asset pattern"],
          matchedTerms: ["fullscreen"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "fullscreen",
          text: "existing asset",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "adjacent_ui_asset",
        ok: true,
        evidenceSource: "file_change_contract_evidence",
      }),
    );
  });

  it("rejects new UI asset targets without same-directory asset evidence", async () => {
    const targetFile =
      "src/core/design-system/icons/assets/action/fullscreen.svg";
    const supportFile = "src/core/design-system/icons/other/action.svg";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add dialog fullscreen icon asset.",
      specs: [
        {
          id: "fullscreen-asset",
          objective: "Add a design-system asset without local evidence.",
          acceptanceCriteria: ["Unsafe asset adjacency is rejected."],
          targetFiles: [targetFile],
          implementationNotes: ["Do not accept cross-directory asset evidence."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "config_required",
          editable: true,
          rationale:
            "This should not pass because the inspected asset is in another directory.",
          supportingEvidence: [`Read ${supportFile} as an icon template.`],
          allowedChanges: ["Create the fullscreen SVG asset."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-06-23T12:00:00.000Z",
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "fullscreen", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["fullscreen"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "fullscreen",
          text: "existing asset",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "not an allowed adjacent source",
    );
  });

  it("rejects adjacent target rationales that cite unrelated evidence-backed files", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
              rationale:
                "This cites evidence, but not the file that actually supports Sass adjacency.",
              supportingFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
              ],
            },
          ],
          implementationNotes: [
            "Follow the existing custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
        {
          path: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          score: 25,
          reasons: ["content match"],
          matchedTerms: ["MemberSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          line: 1,
          term: "cancelButton",
          text: ".csPrimaryButton",
        },
        {
          file: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          line: 1,
          term: "MemberSearchForm",
          text: "class MemberSearchForm",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "adjacency-supporting evidence file",
    );
  });

  it("rejects adjacent Sass targets without rationale", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create an adjacent cancel button Sass partial.",
          acceptanceCriteria: [
            "Cancel button style is defined in source Sass.",
          ],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
          ],
          implementationNotes: [
            "Follow the existing custom Sass partial convention.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          line: 1,
          term: "cancelButton",
          text: ".csPrimaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("targetFileRationales");
    expect(validation.decisions[0]).toMatchObject({
      evidenceSource: "missing_file_change_contract_evidence",
    });
  });

  it("rejects adjacent style targets backed only by unrelated or generated theme evidence", async () => {
    const basePlan = {
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    const differentDirectoryPlan = parseOneShotPlan({
      ...basePlan,
      specs: [
        {
          id: "wrong-dir-style",
          objective: "Create a style file in a different directory.",
          acceptanceCriteria: ["Style target is rejected."],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/forms/_csCancelButton.scss",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/forms/_csCancelButton.scss",
              rationale:
                "This should not pass because the evidence is in another directory.",
              supportingFiles: [
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
              ],
            },
          ],
          implementationNotes: [
            "Do not allow cross-directory style adjacency.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });
    const javaOnlyPlan = parseOneShotPlan({
      ...basePlan,
      specs: [
        {
          id: "java-backed-style",
          objective: "Create a style file backed only by Java evidence.",
          acceptanceCriteria: ["Style target is rejected."],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss",
              rationale: "Java evidence alone cannot justify a Sass sibling.",
              supportingFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
              ],
            },
          ],
          implementationNotes: [
            "Do not allow Java-only evidence for style adjacency.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });
    const generatedThemePlan = parseOneShotPlan({
      ...basePlan,
      specs: [
        {
          id: "generated-theme-style",
          objective: "Create a runtime theme sibling.",
          acceptanceCriteria: ["Generated theme target is rejected."],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3/_csCancelButton.scss",
          ],
          targetFileRationales: [
            {
              targetFile:
                "MedicalMgmt/src/main/webapp/themes/Medhok3/_csCancelButton.scss",
              rationale:
                "Generated skin evidence cannot justify new runtime theme siblings.",
              supportingFiles: [
                "MedicalMgmt/src/main/webapp/themes/Medhok3/skin_styles.css",
              ],
            },
          ],
          implementationNotes: [
            "Do not allow generated runtime theme adjacency.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });

    const styleGrounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "cancelButton", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          line: 1,
          term: "cancelButton",
          text: ".csPrimaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };
    const javaGrounding = {
      ...styleGrounding,
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["MemberSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          line: 1,
          term: "MemberSearchForm",
          text: "class MemberSearchForm",
        },
      ],
    };
    const generatedGrounding = {
      ...styleGrounding,
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3/skin_styles.css",
          score: 30,
          reasons: ["content match", "route card generated style output"],
          matchedTerms: ["cancelButton"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/webapp/themes/Medhok3/skin_styles.css",
          line: 1,
          term: "cancelButton",
          text: ".button",
        },
      ],
      riskFiles: ["MedicalMgmt/src/main/webapp/themes/Medhok3/skin_styles.css"],
    };

    expect(
      validatePlanAgainstGrounding(differentDirectoryPlan, styleGrounding).ok,
    ).toBe(false);
    expect(validatePlanAgainstGrounding(javaOnlyPlan, javaGrounding).ok).toBe(
      false,
    );
    const generatedValidation = validatePlanAgainstGrounding(
      generatedThemePlan,
      generatedGrounding,
    );
    expect(generatedValidation.ok).toBe(false);
    expect(generatedValidation.errors.join("\n")).toContain(
      "generated or global theme file",
    );
  });

  it("accepts exact style evidence targets without rationale", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Edit existing button style.",
      specs: [
        {
          id: "existing-button-style",
          objective: "Edit an existing Sass partial.",
          acceptanceCriteria: ["Existing style target is accepted."],
          targetFiles: [
            "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          ],
          implementationNotes: [
            "Exact evidence target does not require an adjacency rationale.",
          ],
          validationSteps: ["compass compile"],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-STYLE",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [{ value: "button", kind: "word" as const, weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          score: 30,
          reasons: ["content match", "route card style pattern"],
          matchedTerms: ["buttonStyle"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
          line: 1,
          term: "buttonStyle",
          text: ".csPrimaryButton",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [
        "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss",
      ],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
  });

  it("soft-accepts same-package Java test targets whose stems only partially overlap evidence", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Reject unrelated tests.",
      specs: [
        {
          id: "bad-test",
          objective: "Allow same-package Java test coverage despite partial stem overlap.",
          acceptanceCriteria: ["Same-package Java test target validates."],
          targetFiles: [
            "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
          ],
          implementationNotes: [
            "UserSearchForm evidence can validate same-package MemberSearchFormTest.",
          ],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "UserSearchForm", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/UserSearchForm.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["UserSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmt/src/main/java/com/medhok/mm/client/member/UserSearchForm.java",
          line: 20,
          term: "UserSearchForm",
          text: "class UserSearchForm",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.warnings.join("\n")).toContain(
      "same-package Java test target",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile:
          "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberSearchFormTest.java",
        kind: "same_package_java_test_accepted_soft",
        ok: true,
        supportingFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/UserSearchForm.java",
        ],
      }),
    );
  });

  it("accepts new colocated TSX test targets backed by the inspected source component and fileChangeContract proof", async () => {
    const sourceFile =
      "src/intake/intake-document-page/intake-wizard/wizard-steps/components/loa/loa.tsx";
    const targetFile =
      "src/intake/intake-document-page/intake-wizard/wizard-steps/components/loa/loa.test.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-7116",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add LOA component test coverage.",
      specs: [
        {
          id: "loa-test",
          objective: "Add colocated test coverage for the LOA component.",
          acceptanceCriteria: [
            "The LOA component test covers generated field IDs.",
          ],
          targetFiles: [targetFile],
          implementationNotes: ["Use the existing FormProvider test pattern."],
          validationSteps: ["npm test -- loa.test.tsx"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "test_required",
          editable: true,
          rationale:
            "New colocated test validates the inspected LOA component behavior.",
          supportingEvidence: [
            `Read ${sourceFile} as the source component under test.`,
          ],
          allowedChanges: ["Create the colocated LOA test."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-06-23T12:00:00.000Z",
      jiraKey: "CPDEV-7116",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        {
          value: "UM_PROVIDER_SERVICING_LOA",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: sourceFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["UM_PROVIDER_SERVICING_LOA"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: sourceFile,
          line: 1,
          term: "UM_PROVIDER_SERVICING_LOA",
          text: "export function Loa() { return UM_PROVIDER_SERVICING_LOA; }",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "adjacent_colocated_test",
        ok: true,
        evidenceSource: "file_change_contract_evidence",
        rationaleRequired: true,
        rationalePresent: true,
        supportingFiles: [sourceFile],
      }),
    );
  });

  it("rejects new colocated TSX test targets backed only by unrelated pattern-test evidence", async () => {
    const targetFile =
      "src/intake/intake-document-page/intake-wizard/wizard-steps/components/loa/loa.test.tsx";
    const supportFile =
      "src/intake/medical-appeals-wizard/components/medical-appeal-section/medical-appeal-section.test.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-7116",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add LOA component test coverage.",
      specs: [
        {
          id: "loa-test",
          objective: "Add colocated test coverage without source evidence.",
          acceptanceCriteria: [
            "A pattern test alone cannot justify the colocated target.",
          ],
          targetFiles: [targetFile],
          implementationNotes: ["Do not accept unrelated pattern-test evidence."],
          validationSteps: ["npm test -- loa.test.tsx"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "test_required",
          editable: true,
          rationale:
            "This should not pass because only an unrelated pattern test was inspected.",
          supportingEvidence: [`Read ${supportFile} for test wrapper style.`],
          allowedChanges: ["Create the colocated LOA test."],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-06-23T12:00:00.000Z",
      jiraKey: "CPDEV-7116",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        {
          value: "MedicalAppealSection",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: supportFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["MedicalAppealSection"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: supportFile,
          line: 1,
          term: "MedicalAppealSection",
          text: "render(<MedicalAppealSection />)",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "test target does not match evidence-backed source",
    );
  });

  it("keeps long-name colocated TSX tests on the existing exact-stem test lane", async () => {
    const sourceFile = "src/member/MemberSearchForm.tsx";
    const targetFile = "src/member/MemberSearchForm.test.tsx";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-TSX",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add member search test coverage.",
      specs: [
        {
          id: "member-search-test",
          objective: "Add colocated test coverage for member search.",
          acceptanceCriteria: ["Member search test target validates."],
          targetFiles: [targetFile],
          implementationNotes: ["Use the existing exact-stem test lane."],
          validationSteps: ["npm test -- MemberSearchForm.test.tsx"],
        },
      ],
    });
    const grounding = {
      generatedAt: "2026-06-23T12:00:00.000Z",
      jiraKey: "CPDEV-TSX",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "MemberSearchForm", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: sourceFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["MemberSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: sourceFile,
          line: 1,
          term: "MemberSearchForm",
          text: "export function MemberSearchForm()",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "adjacent_test",
        ok: true,
        supportingFiles: [sourceFile],
      }),
    );
  });

  it("soft-accepts new adjacent test targets with evidence-backed rationale", async () => {
    const sourceFile =
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java";
    const testFile =
      "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberWorkflowRegressionTest.java";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add focused workflow regression coverage.",
      specs: [
        {
          id: "adjacent-test",
          objective:
            "Add adjacent regression coverage around member workflow behavior.",
          acceptanceCriteria: [
            "Regression coverage exercises the member workflow.",
          ],
          targetFiles: [testFile],
          targetFileRationales: [
            {
              targetFile: testFile,
              rationale:
                "MemberSearchForm is the inspected source entry point for the workflow regression.",
              supportingFiles: [sourceFile],
            },
          ],
          implementationNotes: [
            "Add a focused test in the existing member test tree.",
          ],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "MemberSearchForm", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: sourceFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["MemberSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: sourceFile,
          line: 20,
          term: "MemberSearchForm",
          text: "class MemberSearchForm",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.warnings.join("\n")).toContain(
      "same-package Java test target",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: testFile,
        kind: "same_package_java_test_accepted_soft",
        ok: true,
        supportingFiles: [sourceFile],
      }),
    );
  });

  it("soft-accepts adjacent source targets when rationale misses adjacency-supporting evidence", async () => {
    const targetFile =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/WSUMQuestionSetRequest.java";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21561",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create internal DTR request model.",
      specs: [
        {
          id: "request-model",
          objective: "Create request model for getUmQuestionSet.",
          acceptanceCriteria: ["Request model captures UM question-set input."],
          targetFiles: [targetFile],
          targetFileRationales: [
            {
              targetFile,
              rationale:
                "Swagger and an uninspected DTO suggest the model shape.",
              supportingFiles: [
                "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/DtrDocumentationRequest.java",
                "mhk-interopt-fhirhelper/medhokqa-swagger-api-docs.json",
              ],
            },
          ],
          implementationNotes: ["Relax source-file grounding to warnings."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21561",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "CrdAdditionalDocEnum",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["CrdAdditionalDocEnum"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
          line: 1,
          term: "CrdAdditionalDocEnum",
          text: "enum CrdAdditionalDocEnum",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(
      plan,
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
        ],
      },
    );

    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings.join("\n")).toContain(
      "accepted as an adjacent source or mapping target",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "adjacent_source_accepted_soft",
        ok: true,
        reason:
          "adjacent target rationale must reference at least one adjacency-supporting evidence file",
        recoveryCandidateFiles: [
          "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/DtrDocumentationRequest.java",
          "mhk-interopt-fhirhelper/medhokqa-swagger-api-docs.json",
        ],
      }),
    );
  });

  it("prefers recovered source rationale evidence while soft-accepting other adjacent source targets", async () => {
    const targetFile =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/WSUMQuestionSetRequest.java";
    const sourceSupport =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/DtrDocumentationRequest.java";
    const sameDirectoryDocSupport =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/model-notes.json";
    const unrelatedSupport =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/UmPriorAuthorizationService.java";
    const swaggerSupport =
      "mhk-interopt-fhirhelper/medhokqa-swagger-api-docs.json";
    const basePlan = {
      jiraKey: "CPDEV-21561",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create internal DTR request model.",
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };
    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21561",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "CrdAdditionalDocEnum",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["CrdAdditionalDocEnum"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
          line: 1,
          term: "CrdAdditionalDocEnum",
          text: "enum CrdAdditionalDocEnum",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };
    const planWithSupport = (supportingFiles: string[]) =>
      parseOneShotPlan({
        ...basePlan,
        specs: [
          {
            id: "request-model",
            objective: "Create request model for getUmQuestionSet.",
            acceptanceCriteria: [
              "Request model captures UM question-set input.",
            ],
            targetFiles: [targetFile],
            targetFileRationales: [
              {
                targetFile,
                rationale:
                  "A same-package DTO establishes the local model pattern.",
                supportingFiles,
              },
            ],
            implementationNotes: ["Keep source recovery exact and audited."],
            validationSteps: ["mvn test"],
          },
        ],
      });

    const recoveredValidation = validatePlanAgainstGrounding(
      planWithSupport([sourceSupport, swaggerSupport]),
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
        ],
        recoveredSourceRationaleFiles: [sourceSupport],
      },
    );
    const swaggerOnlyValidation = validatePlanAgainstGrounding(
      planWithSupport([swaggerSupport]),
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
        ],
        recoveredSourceRationaleFiles: [swaggerSupport],
      },
    );
    const unrelatedValidation = validatePlanAgainstGrounding(
      planWithSupport([unrelatedSupport]),
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
        ],
        recoveredSourceRationaleFiles: [unrelatedSupport],
      },
    );
    const sameDirectoryDocValidation = validatePlanAgainstGrounding(
      planWithSupport([sameDirectoryDocSupport]),
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java",
        ],
        recoveredSourceRationaleFiles: [sameDirectoryDocSupport],
      },
    );

    expect(recoveredValidation.ok).toBe(true);
    expect(recoveredValidation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile,
        kind: "source_accepted_via_rationale_recovery",
        ok: true,
        supportingFiles: expect.arrayContaining([sourceSupport]),
      }),
    );
    expect(swaggerOnlyValidation.ok).toBe(true);
    expect(unrelatedValidation.ok).toBe(true);
    expect(sameDirectoryDocValidation.ok).toBe(true);
    for (const validation of [
      swaggerOnlyValidation,
      unrelatedValidation,
      sameDirectoryDocValidation,
    ]) {
      expect(validation.decisions).toContainEqual(
        expect.objectContaining({
          targetFile,
          kind: "adjacent_source_accepted_soft",
          ok: true,
        }),
      );
    }
  });

  it("soft-accepts run-108 adjacent request model and same-package Java test targets", async () => {
    const requestModel =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/WSUMQuestionSetRequest.java";
    const existingRequestModel =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/DtrDocumentationRequest.java";
    const serviceSource =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/AbstractCDSOrderService.java";
    const scenarioTest =
      "mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/CDSOrderDispatchInternalDtrTest.java";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21561",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Plan internal DTR documentation requirement handling.",
      specs: [
        {
          id: "internal-dtr",
          objective:
            "Use internal UM question set answers when determining documentation requirement.",
          acceptanceCriteria: [
            "Order-dispatch CRD returns documentation required from internal assessments.",
          ],
          targetFiles: [serviceSource, requestModel, scenarioTest],
          implementationNotes: [
            "Create the adjacent request model and same-package scenario test.",
          ],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21561",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "DtrDocumentationRequest",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: existingRequestModel,
          score: 30,
          reasons: ["content match", "same-package request model pattern"],
          matchedTerms: ["DtrDocumentationRequest"],
          exists: true,
        },
        {
          path: serviceSource,
          score: 30,
          reasons: ["content match", "service implementation entry point"],
          matchedTerms: ["AbstractCDSOrderService"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: existingRequestModel,
          line: 1,
          term: "DtrDocumentationRequest",
          text: "class DtrDocumentationRequest",
        },
        {
          file: serviceSource,
          line: 1,
          term: "AbstractCDSOrderService",
          text: "class AbstractCDSOrderService",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetFile: requestModel,
          kind: "adjacent_source_accepted_soft",
          ok: true,
          rationaleRequired: true,
          rationalePresent: false,
          supportingFiles: expect.arrayContaining([existingRequestModel]),
        }),
        expect.objectContaining({
          targetFile: scenarioTest,
          kind: "same_package_java_test_accepted_soft",
          ok: true,
          supportingFiles: [serviceSource],
        }),
      ]),
    );
    expect(validation.warnings.join("\n")).toContain(
      "accepted as an adjacent source or mapping target",
    );
    expect(validation.warnings.join("\n")).toContain(
      "same-package Java test target",
    );
  });

  it("soft-accepts same-package Java scenario tests backed by source evidence", async () => {
    const sourceFile =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/UmPriorAuthorizationService.java";
    const procedureTest =
      "mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/UmPriorAuthorizationServiceProcedureTest.java";
    const guidelineTest =
      "mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/UmPriorAuthorizationServiceGuidelineTest.java";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Partition internal QuestionnaireResponses.",
      specs: [
        {
          id: "scenario-tests",
          objective: "Add scenario coverage for procedure and guideline flows.",
          acceptanceCriteria: ["Procedure and guideline paths are covered."],
          targetFiles: [procedureTest, guidelineTest],
          implementationNotes: ["Use same-package service tests."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "UmPriorAuthorizationService",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: sourceFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["UmPriorAuthorizationService"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: sourceFile,
          line: 1,
          term: "UmPriorAuthorizationService",
          text: "class UmPriorAuthorizationService",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.warnings.join("\n")).toContain(
      "Java scenario test target",
    );
    expect(validation.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetFile: procedureTest,
          kind: "adjacent_test_scenario_soft",
          ok: true,
          supportingFiles: [sourceFile],
        }),
        expect.objectContaining({
          targetFile: guidelineTest,
          kind: "adjacent_test_scenario_soft",
          ok: true,
          supportingFiles: [sourceFile],
        }),
      ]),
    );
  });

  it("rejects unsupported adjacent migration names and unsafe target paths", async () => {
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Reject unsafe targets.",
      specs: [
        {
          id: "bad-targets",
          objective: "Reject unsafe target files.",
          acceptanceCriteria: ["Bad targets are rejected."],
          targetFiles: [
            "flyway/sql/task_lifecycle_event.sql",
            "../outside/TaskLifecycleEvent.java",
          ],
          implementationNotes: ["These should not validate."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "UserSessionAction", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["UserSessionAction"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          line: 20,
          term: "UserSessionAction",
          text: "class UserSessionAction tracks session actions",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(
      plan,
      grounding,
      undefined,
      {
        finalPlannerReadFiles: [
          "flyway/sql/V1.2025-02-25-72__user_session.sql",
        ],
      },
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "Flyway migration target does not match",
    );
    expect(validation.errors.join("\n")).toContain("unsafe");
  });

  it("accepts a new JSON test fixture when a same-dir sibling is evidence-backed and rationale cites it", async () => {
    const siblingFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test001/04_PAS_FhirBundle.json";
    const newFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test001/05_PAS_FhirBundle_MhkInternalQuestionnaireResponse.json";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add fixture cloned from inspected sibling.",
      specs: [
        {
          id: "fixture-clone",
          objective: "Add MhkInternalQuestionnaireResponse variant fixture.",
          acceptanceCriteria: ["New fixture covers mhk-internal source."],
          targetFiles: [newFixture],
          targetFileRationales: [
            {
              targetFile: newFixture,
              rationale:
                "Clone of the inspected same-dir fixture with QuestionnaireResponse.meta.source changed.",
              supportingFiles: [siblingFixture],
            },
          ],
          implementationNotes: ["Fixture derived from inspected template."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "QuestionnaireResponse",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: siblingFixture,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["QuestionnaireResponse"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: siblingFixture,
          line: 1,
          term: "QuestionnaireResponse",
          text: '"resourceType": "QuestionnaireResponse"',
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.warnings.join("\n")).toContain(
      "accepted as an adjacent test fixture",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: newFixture,
        kind: "adjacent_test_fixture",
        ok: true,
        supportingFiles: [siblingFixture],
      }),
    );
  });

  it("rejects a new JSON test fixture with a specific error when rationale is missing", async () => {
    const siblingFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test001/04_PAS_FhirBundle.json";
    const newFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test001/05_PAS_FhirBundle_MhkInternalQuestionnaireResponse.json";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Missing fixture rationale.",
      specs: [
        {
          id: "fixture-clone",
          objective: "Add MhkInternalQuestionnaireResponse variant fixture.",
          acceptanceCriteria: ["New fixture covers mhk-internal source."],
          targetFiles: [newFixture],
          implementationNotes: ["No rationale emitted."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "QuestionnaireResponse",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: siblingFixture,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["QuestionnaireResponse"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: siblingFixture,
          line: 1,
          term: "QuestionnaireResponse",
          text: '"resourceType": "QuestionnaireResponse"',
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "new test fixture target requires a targetFileRationales entry citing an inspected sibling file in the same directory",
    );
    expect(validation.errors.join("\n")).toContain(siblingFixture);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: newFixture,
        kind: "rejected",
        rationaleRequired: true,
        rationalePresent: false,
      }),
    );
  });

  it("rejects a new JSON test fixture when rationale cites a file outside evidence-backed same-dir siblings", async () => {
    const siblingFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test001/04_PAS_FhirBundle.json";
    const newFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test001/05_PAS_FhirBundle_MhkInternalQuestionnaireResponse.json";
    const unrelatedFixture =
      "mhk-interopt-fhirhelper/src/test/resources/pas/guideline/test002/01_Other.json";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Rationale cites wrong directory.",
      specs: [
        {
          id: "fixture-clone",
          objective: "Add variant fixture cloning a template.",
          acceptanceCriteria: ["New fixture covers mhk-internal source."],
          targetFiles: [newFixture],
          targetFileRationales: [
            {
              targetFile: newFixture,
              rationale: "Clone from a template in another directory.",
              supportingFiles: [unrelatedFixture],
            },
          ],
          implementationNotes: [
            "Rationale supporting file is not in same dir.",
          ],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-01T00:00:00.000Z",
      jiraKey: "CPDEV-21565",
      repoName: "interop",
      confidence: "strong" as const,
      terms: [
        {
          value: "QuestionnaireResponse",
          kind: "identifier" as const,
          weight: 10,
        },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: siblingFixture,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["QuestionnaireResponse"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: siblingFixture,
          line: 1,
          term: "QuestionnaireResponse",
          text: '"resourceType": "QuestionnaireResponse"',
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "new test fixture target requires a targetFileRationales entry citing an inspected sibling file in the same directory",
    );
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: newFixture,
        kind: "rejected",
        rationaleRequired: true,
        rationalePresent: true,
      }),
    );
  });

  it("accepts YAML, XML, and CSV fixtures through the fixture lane", async () => {
    const yamlSibling = "svc/src/test/resources/scenarios/01_base.yaml";
    const yamlTarget = "svc/src/test/resources/scenarios/02_variant.yaml";
    const xmlSibling = "svc/src/test/resources/envelopes/hello.xml";
    const xmlTarget = "svc/src/test/resources/envelopes/world.xml";
    const csvSibling = "svc/src/test/resources/data/rows_a.csv";
    const csvTarget = "svc/src/test/resources/data/rows_b.csv";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-21599",
      repoName: "svc",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Multiple fixture extensions route through fixture lane.",
      specs: [
        {
          id: "multi-ext",
          objective: "Add fixture variants.",
          acceptanceCriteria: ["Fixtures cover extra scenarios."],
          targetFiles: [yamlTarget, xmlTarget, csvTarget],
          targetFileRationales: [
            {
              targetFile: yamlTarget,
              rationale: "Clone of inspected YAML sibling.",
              supportingFiles: [yamlSibling],
            },
            {
              targetFile: xmlTarget,
              rationale: "Clone of inspected XML sibling.",
              supportingFiles: [xmlSibling],
            },
            {
              targetFile: csvTarget,
              rationale: "Clone of inspected CSV sibling.",
              supportingFiles: [csvSibling],
            },
          ],
          implementationNotes: ["Cloned from inspected siblings."],
          validationSteps: ["./gradlew test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-05-02T00:00:00.000Z",
      jiraKey: "CPDEV-21599",
      repoName: "svc",
      confidence: "strong" as const,
      terms: [{ value: "scenarios", kind: "identifier" as const, weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: yamlSibling,
          score: 20,
          reasons: ["content match"],
          matchedTerms: ["scenarios"],
          exists: true,
        },
        {
          path: xmlSibling,
          score: 20,
          reasons: ["content match"],
          matchedTerms: ["scenarios"],
          exists: true,
        },
        {
          path: csvSibling,
          score: 20,
          reasons: ["content match"],
          matchedTerms: ["scenarios"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: yamlSibling,
          line: 1,
          term: "scenarios",
          text: "scenarios: []",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    const fixtureDecisions = validation.decisions.filter(
      (d) => d.kind === "adjacent_test_fixture",
    );
    expect(fixtureDecisions).toHaveLength(3);
    expect(fixtureDecisions.map((d) => d.targetFile).sort()).toEqual(
      [yamlTarget, xmlTarget, csvTarget].sort(),
    );
  });

  it("keeps .java test files on a source-backed test lane instead of the fixture lane", async () => {
    const sourceFile =
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java";
    const javaTest =
      "MedicalMgmt/src/test/java/com/medhok/mm/client/member/MemberWorkflowRegressionTest.java";
    const plan = parseOneShotPlan({
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Java test adjacent to inspected source.",
      specs: [
        {
          id: "adjacent-java-test",
          objective: "Add regression coverage.",
          acceptanceCriteria: ["Regression exercises the workflow."],
          targetFiles: [javaTest],
          targetFileRationales: [
            {
              targetFile: javaTest,
              rationale:
                "MemberSearchForm is the inspected source entry point.",
              supportingFiles: [sourceFile],
            },
          ],
          implementationNotes: ["Adjacent Java test."],
          validationSteps: ["mvn test"],
        },
      ],
    });

    const grounding = {
      generatedAt: "2026-04-17T12:00:00.000Z",
      jiraKey: "CPDEV-18975",
      repoName: "core-app",
      confidence: "strong" as const,
      terms: [
        { value: "MemberSearchForm", kind: "identifier" as const, weight: 10 },
      ],
      routeCards: [],
      candidateFiles: [
        {
          path: sourceFile,
          score: 30,
          reasons: ["content match"],
          matchedTerms: ["MemberSearchForm"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: sourceFile,
          line: 20,
          term: "MemberSearchForm",
          text: "class MemberSearchForm",
        },
      ],
      sourceTestPairs: [],
      riskFiles: [],
      warnings: [],
    };

    const validation = validatePlanAgainstGrounding(plan, grounding);

    expect(validation.ok).toBe(true);
    expect(validation.decisions).toContainEqual(
      expect.objectContaining({
        targetFile: javaTest,
        kind: "same_package_java_test_accepted_soft",
        ok: true,
      }),
    );
  });
});
