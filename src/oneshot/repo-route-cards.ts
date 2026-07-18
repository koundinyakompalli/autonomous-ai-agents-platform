export interface RepoRouteCard {
  id: string
  title: string
  triggerPhrases: string[]
  guidance: string[]
  entrypointHints?: string[]
}

const CORE_APP_ROUTE_CARDS: RepoRouteCard[] = [
  {
    id: 'core-app.member-search-form',
    title: 'MemberSearchForm',
    triggerPhrases: [
      'member search',
      'membersearch',
      'member lookup',
      'subscriber search',
    ],
    guidance: [
      'Start by locating MemberSearchForm and adjacent presenter/service classes before broad repository search.',
      'Prefer existing SmartGWT form field, validation, and event handler patterns over introducing a new UI idiom.',
      'Plan the smallest member-search target file set plus matching focused tests.',
    ],
    entrypointHints: [
      'MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java',
      'MedicalMgmt/src/main/java/com/medhok/mm/server/handlers/MemberSearchHandler.java',
      'MedicalMgmt/src/main/java/com/medhok/mm/server/bff/services/member/BffMemberService.java',
      'MedicalMgmt/src/main/java/com/medhok/mm/client/ui/datasource/MemberSearchDS.java',
    ],
  },
  {
    id: 'core-app.smartgwt-style',
    title: 'SmartGWT Button/Style Patterns',
    triggerPhrases: ['smartgwt', 'button', 'style', 'css', 'scss', 'theme'],
    guidance: [
      'Inspect existing SmartGWT button construction and style-name helpers before selecting target files.',
      'Check whether the visual change belongs in Java widget code, shared style constants, or theme CSS/SCSS.',
      'Avoid broad UI rewrites when a style-name or theme token change can satisfy the ticket.',
    ],
    entrypointHints: [
      'MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csPrimaryButton.scss',
      'MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss',
      'MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csToolbarButton.scss',
      'MedicalMgmt/src/main/webapp/Medhok3.css',
    ],
  },
  {
    id: 'core-app.theme-pipeline',
    title: 'Theme SCSS/CSS Pipeline',
    triggerPhrases: ['theme', 'scss', 'css', 'stylesheet', 'branding', 'color'],
    guidance: [
      'Identify the active theme asset and generated CSS path before planning edits.',
      'Treat theme, build, and generated stylesheet files as shared-risk areas that need explicit validation.',
      'Do not plan changes to generated CSS unless the repository convention shows generated assets are committed.',
    ],
    entrypointHints: [
      'MedicalMgmt/src/main/webapp/themes/Medhok3_Source/Medhok3.scss',
      'MedicalMgmt/src/main/webapp/themes/Medhok3_Source/_mhkVariables.scss',
      'MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/_userStyles.scss',
      'MedicalMgmt/src/main/webapp/themes/Medhok3/skin_styles.css',
    ],
  },
  {
    id: 'core-app.transactional-workspace',
    title: 'TransactionalWorkSpace / Case Workspace Routing',
    triggerPhrases: [
      'transactionalworkspace',
      'transactional workspace',
      'case workspace',
      'workspace routing',
      'case routing',
    ],
    guidance: [
      'Start with TransactionalWorkSpace and related case/workspace route registration rather than scanning every screen.',
      'Map the ticket to a specific case type, tab, or workflow before planning implementation.',
      'If the ticket says all screens, all modules, or all workflows without a central hook, qualification should block before planning.',
    ],
    entrypointHints: [
      'MedicalMgmt/src/main/java/com/medhok/mm/client/utils/TransactionalWorkSpace.java',
      'MedicalMgmt/src/main/java/com/medhok/mm/client/WorkSpace.java',
      'MedicalMgmt/src/main/java/com/medhok/mm/client/utils/TransactionalWorkSpaceCallback.java',
    ],
  },
  {
    id: 'core-app.web-service-contracts',
    title: 'Core Web-Service Contracts',
    triggerPhrases: [
      'core web service',
      'core web-service',
      'mhk core api',
      'medhok web service',
      'medhok-web-services',
      'ws-doc-api',
      'authrestservices',
      'submitpreauth',
      'fetchmember',
      'wsmemberquery',
      'wspreauthinput',
      'wsquestionset',
      'wsguideline',
      'rxparestservices',
      'getquestionsetrx',
      'getcptcodes',
      'medhokqa-swagger-api-docs',
      'swagger',
      'openapi',
    ],
    guidance: [
      'Start with the Core web-service module, generated API docs, and matching MedicalMgmt service/model paths before planning contract changes.',
      'For InterOP companion work, identify the exact CoreRestClient call, WS* model, swagger field, and endpoint behavior that the InterOP child run depends on.',
      'Preserve backward-compatible request and response contracts unless the Jira explicitly requires a breaking change and lists all dependent consumers.',
      'When changing swagger/OpenAPI output or generated API models, plan regeneration plus focused tests for both service behavior and model serialization.',
      'In a multi-repo run group, keep this child run scoped to Core web-service changes and describe the InterOP dependency in PR notes.',
    ],
    entrypointHints: [
      'medhok-web-services',
      'ws-doc-api',
      'MedicalMgmt',
      'MedicalMgmtModels',
      'full-api-docs.json',
      'api-current.json',
      'generate_rest_api_docs.py',
      'WEBSERVICES-SETUP_INSTRUCTIONS.md',
    ],
  },
]

const AI_AGENTS_ROUTE_CARDS: RepoRouteCard[] = [
  {
    id: 'ai-agents.controller-agent-hosting',
    title: 'Controller Agent Hosting',
    triggerPhrases: [
      'controller agent',
      'controller agents',
      'host agent',
      'host agents',
      'agent hosting',
      'new agent',
      'implement agent',
      'agent registry',
    ],
    guidance: [
      'Start with the platform repo guidance in CLAUDE.md, the detailed NEVER rules, and the build/validation guide before planning implementation.',
      'Use the relevant docs/ subfolders for the ticket scope; do not broad-load unrelated documentation when a focused architecture, operations, security, or implementation guide applies.',
      'Controller agents decide orchestration; processing agents execute assigned work and must not choose workflow routing.',
      'Prefer Terraform/IaC-managed registration, queues, IAM, alarms, and deployment wiring over runtime self-registration or direct database writes.',
      'Plan module-scoped Maven tests plus any affected Terraform validation; do not propose direct pushes to master.',
    ],
    entrypointHints: [
      'CLAUDE.md',
      'docs/reference/NEVER-RULES-DETAILED.md',
      'docs/guides/BUILD-AND-DEPLOYMENT.md',
      'docs/architecture',
      'docs/operations',
      'agent-orchestration-core/src',
      'controller-agents',
      'terraform/30-controller-agents',
      'shared-libs/ai-orchestration-commons',
    ],
  },
  {
    id: 'ai-agents.mcp-server',
    title: 'MCP Server / Tool Integration',
    triggerPhrases: [
      'mcp',
      'mcp server',
      'tool server',
      'atlassian mcp',
      'document360 mcp',
      'code intelligence mcp',
      'internal mcp',
      'external mcp',
    ],
    guidance: [
      'Identify whether the change belongs in a concrete MCP server, shared MCP protocol library, or infrastructure routing.',
      'Read CLAUDE.md and the NEVER rules first, then use MCP-specific docs under docs/architecture, docs/guides, docs/security, or docs/implementations when present.',
      'For platform-internal MCP servers, follow the shared internal ALB host-routing pattern; do not introduce a new ALB or certificate without explicit justification.',
      'Production service-to-service traffic must use HTTPS through the approved ALB/certificate pattern; localhost health checks are the narrow exception.',
      'Preserve authentication, tenant context, audit logging, and fail-closed security behavior.',
    ],
    entrypointHints: [
      'CLAUDE.md',
      'docs/reference/NEVER-RULES-DETAILED.md',
      'docs/guides/BUILD-AND-DEPLOYMENT.md',
      'docs/security',
      'docs/implementations',
      'agent-core-mcp/src',
      'atlassian-mcp-server/src',
      'document360-mcp-server/src',
      'code-intelligence-mcp-server/src',
      'shared-libs/mcp-protocol',
      'terraform/47-internal-mcp-alb',
      'terraform/25-external-mcp-servers',
    ],
  },
  {
    id: 'ai-agents.processing-agent',
    title: 'Processing Agent Changes',
    triggerPhrases: [
      'processing agent',
      'processing agents',
      'java agent',
      'python agent',
      'document processing',
      'llm processing',
      'clinical criteria',
      'ocr text extraction',
    ],
    guidance: [
      'Read CLAUDE.md and the detailed NEVER rules before changing processing-agent behavior.',
      'Keep processing agents deterministic executors of assigned tasks; escalation or routing decisions belong to controller agents.',
      'Never log LLM request/response bodies or PHI-bearing payloads; log length, hashes, identifiers, and status only.',
      'Add focused module tests and preserve workflow failure propagation rather than swallowing errors or reporting fake success.',
      'When deployment is affected, pair code changes with Terraform/SQS/IAM/alarm updates under the processing-agent infrastructure paths.',
    ],
    entrypointHints: [
      'CLAUDE.md',
      'docs/reference/NEVER-RULES-DETAILED.md',
      'docs/guides/BUILD-AND-DEPLOYMENT.md',
      'docs/patterns',
      'docs/security',
      'processing-agents/java-agents',
      'processing-agents/python-agents',
      'terraform/40-processing-agents',
      'shared-libs/python-sdk',
      'shared-libs/ai-orchestration-commons',
    ],
  },
  {
    id: 'ai-agents.aws-saas-infra',
    title: 'AWS SaaS Infrastructure',
    triggerPhrases: [
      'terraform',
      'aws',
      'ecs',
      'fargate',
      'sqs',
      'kms',
      'vpc',
      'private subnet',
      'ui portal',
      'deployment',
      'hosted on aws',
    ],
    guidance: [
      'Read CLAUDE.md, the detailed NEVER rules, and relevant docs/security, docs/operations, docs/architecture, and docs/iam-policies material before planning infrastructure changes.',
      'Treat infrastructure changes as high-risk healthcare SaaS work: preserve private-subnet ECS, KMS encryption, tenant isolation, audit logging, and least privilege.',
      'Do not plan public task networking, plaintext service-to-service calls, broad IAM grants, or hardcoded credentials.',
      'Use environment-specific Terraform variable files and deployment workflows; avoid ad hoc AWS console-only changes.',
      'For UI portal changes, keep API/auth assumptions explicit and run type-check, lint, tests, and build where feasible.',
    ],
    entrypointHints: [
      'CLAUDE.md',
      'docs/reference/NEVER-RULES-DETAILED.md',
      'docs/guides/BUILD-AND-DEPLOYMENT.md',
      'docs/security',
      'docs/operations',
      'docs/architecture',
      'docs/iam-policies',
      'terraform/00-shared',
      'terraform/10-orchestration-core',
      'terraform/15-internal-services',
      'terraform/30-controller-agents',
      'terraform/40-processing-agents',
      'terraform/70-ui-portal',
      'ui-portal/src',
      '.github/workflows',
    ],
  },
]

const INTEROP_ROUTE_CARDS: RepoRouteCard[] = [
  {
    id: 'interop.baseline',
    title: 'InterOP Development Baseline',
    triggerPhrases: [
      'interop',
      'interoperability',
      'fhir',
      'da vinci',
      'davinci',
      'cms-0057',
      'crd',
      'dtr',
      'pas',
      'medpharm',
      'interqual',
      'mcg',
      'healthlake',
    ],
    guidance: [
      'Before planning code, map the Jira parent, child stories, linked PRs, and related commits; InterOP parent epics often use different child CPDEV keys in implementation PRs.',
      'Search open and merged PRs by Jira key, title phrase, and affected service class, then refresh from the target branch before creating implementation work.',
      'Build an acceptance matrix that links Jira criteria to FHIR resource/profile/extension behavior, target service methods, runtime config, fixtures, and validation commands.',
      'Do not hardcode demo payors, JCodes, NDCs, portal URLs, or client messages; prefer PropertyHelper/ApplicationPropertyRepository and existing client configuration patterns.',
      'When behavior depends on secrets, Terraform, MHK Core API models, swagger docs, or deployment order, include those artifacts in the plan and PR notes.',
      'If the story requires CoreRestClient, generated MHK API models, AuthRestServices, RxPARestServices, fetchMember, submitPreAuth, getQuestionSetRX, or Core eligibility changes, treat it as a multi-repo candidate with a companion core-app child run.',
    ],
    entrypointHints: [
      'README.md',
      'docs/Interop-IT-OPS-Reference.md',
      'docs/runbooks/interop-monitoring-runbook.md',
      'docs/CDS_Hooks_Implementation_Guide.md',
      'docs/FHIR-PAS-MedPharm-Implementation-Guide.md',
      'docs/Internal-Assessment-DTR-Implementation-Guide.md',
      'docs/Interqual-Configuration-Deployment-Guide.md',
      'docs/MCG-Documentation.md',
      'docs/Prior-Authorization-Cancellation-Implementation-Guide.md',
      'mhk-interopt-fhirhelper/pom.xml',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/common/util/PropertyHelper.java',
      'mhk-interopt-fhirhelper/src/main/resources/application.properties',
    ],
  },
  {
    id: 'interop.crd-medpharm',
    title: 'CRD / MedPharm PA List',
    triggerPhrases: [
      'crd',
      'coverage requirements discovery',
      'cds hook',
      'cds-hooks',
      'order sign',
      'order-sign',
      'order select',
      'order-select',
      'order dispatch',
      'order-dispatch',
      'medpharm',
      'jcode',
      'j-code',
      'pa list',
      'pa-list',
      'pa-needed',
      'doc-needed',
      'lob',
    ],
    guidance: [
      'Compare order-sign, order-select, and order-dispatch behavior before changing only one hook; prior fixes often had to port the same PA-list mode across all three.',
      'Validate the exact CRD card semantics: covered status, pa-needed, doc-needed, source extension, rejected/no-auth messages, and multi-order isolation.',
      'For LOB or PA-list work, confirm Coverage.class group/plan extraction and MHK Core query fields, especially for dual-coverage members.',
      'If Coverage, eligibility, or CPT lookup needs a Core web-service field or filter that does not exist yet, create a companion Core child run instead of only patching InterOP mapping code.',
      'Keep legacy behavior behind explicit mode toggles and defaults; document whether the story is PA-list-driven, LOB-driven, or a client-specific override.',
      'Use focused service tests with MedicationRequest and ServiceRequest variants when the production path supports both.',
    ],
    entrypointHints: [
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/AbstractCDSOrderService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/CDSOrderSignService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/CDSOrderSelectService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/CDSOrderDispatchService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/mhk/service/MemberService.java',
      'mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service',
    ],
  },
  {
    id: 'interop.dtr-engines',
    title: 'DTR Clinical Engines',
    triggerPhrases: [
      'dtr',
      'documentation templates and rules',
      'questionnaire package',
      'questionnaire-package',
      '$questionnaire-package',
      'next question',
      'next-question',
      '$next-question',
      'documentation requirements',
      'documentation-requirements',
      'generate guidance',
      'generate-guidance',
      'save to mrs',
      'save-to-mrs',
      '$save-to-mrs',
      'interqual',
      'mcg',
      'mhk internal',
      'packagebundle',
    ],
    guidance: [
      'Identify the provider path first: InterQual, MCG, MHK internal, mock, or noop; use DtrClientFactory/provider routing patterns instead of conditional one-offs.',
      'Keep provider-specific FHIR Parameters construction inside the provider client and expose provider-agnostic request/response DTOs to CRD/PAS services when possible.',
      'For MCG and InterQual, preserve OAuth/token-cache, retry, OperationOutcome, meta.source, and unsupported-operation behavior from the existing clients.',
      'For internal DTR, distinguish phase stubs from implemented operations and return standards-appropriate 501/400 OperationOutcome responses.',
      'Pair engine changes with config, secrets, Terraform, and manual sandbox validation notes when external credentials or runtime provider switching are involved.',
    ],
    entrypointHints: [
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/controller/DTRController.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/DTRService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/DtrClient.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/DtrClientFactory.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/InterqualDtrClient.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/McgDtrClient.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/MhkDtrClient.java',
      'terraform',
    ],
  },
  {
    id: 'interop.pas-submit-inquire-cancel',
    title: 'PAS Submit / Inquire / Cancel',
    triggerPhrases: [
      'pas',
      'prior authorization support',
      '$submit',
      'submit',
      '$inquire',
      'inquire',
      'claimresponse',
      'claim response',
      'operationoutcome',
      'operation outcome',
      'questionnaireresponse',
      'questionnaire response',
      'wsquestionset',
      'cancel',
      'cancellation',
      'line-level',
      'claim-level',
      'rfi',
      'communicationrequest',
    ],
    guidance: [
      'Separate UM and MedPharm module behavior before editing shared PAS orchestration; confirm whether the change belongs in module handlers, builders, or controller error handling.',
      'For ClaimResponse or OperationOutcome work, assert HTTP status, FHIR issue severity/code, diagnostics, expressions, meta.source, and correlation ID behavior.',
      'For QuestionnaireResponse handling, verify meta.source partitioning, contained Questionnaire lookup, linkId-to-question mapping, and WSQuestionSet conversion.',
      'For submit, inquire, or cancellation changes, compare InterOP builders against Core AuthRestServices/RxPARestServices contracts before assuming the current WS* model can carry the required data.',
      'Never log clinical answers, request/response bodies, tokens, or PHI-bearing payloads; log identifiers, counts, and statuses only.',
      'Use adjacent PAS fixture tests and clone existing JSON resources only when the rationale cites an inspected sibling fixture.',
    ],
    entrypointHints: [
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/controller/PriorAuthorizationSupportController.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/AbstractPriorAuthorizationService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/UmPriorAuthorizationService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/MedPharmPriorAuthorizationService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/PriorAuthInquireService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/MedPharmPriorAuthCancellationService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/builders/FhirQuestionnaireResponseToWSQuestionSetBuilder.java',
      'mhk-interopt-fhirhelper/src/test/resources/pas',
    ],
  },
  {
    id: 'interop.platform-config',
    title: 'InterOP Platform / Config',
    triggerPhrases: [
      'platform',
      'healthlake',
      'documentreference',
      'document reference',
      'presigned url',
      'pre-signed url',
      's3',
      'terraform',
      'secret',
      'secrets manager',
      'runtime config',
      'applicationproperty',
      'application property',
      'swagger',
      'openapi',
    ],
    guidance: [
      'Treat HealthLake, DocumentReference, presigned upload, swagger, and Terraform changes as cross-boundary work; include deployment order and dependent repo changes.',
      'For HealthLake reads, preserve retry/fallback semantics and distinguish HealthLake 404 fallback from other service failures.',
      'For swagger/OpenAPI model work, plan regeneration impacts and update code/tests that consume generated MHK Core models.',
      'For runtime properties, document defaults, client override behavior, seeding expectations, and backward compatibility.',
      'For Terraform/secrets, use additive environment variables and Secrets Manager references; never commit real credentials.',
    ],
    entrypointHints: [
      'mhk-interopt-fhirhelper/medhokqa-swagger-api-docs.json',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/HealthLakeServiceR4.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/HealthLakeService.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/CommunicationRequestServiceImpl.java',
      'mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/common/service/CoreRestClient.java',
      'terraform/main.tf',
      'terraform/variables.tf',
      'terraform/prerequisites.tf',
    ],
  },
]

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function containsPhrase(text: string, phrase: string): boolean {
  return text.includes(normalize(phrase))
}

function isCoreApp(repoName: string): boolean {
  return normalize(repoName) === 'core-app'
}

function isAiAgents(repoName: string): boolean {
  const normalized = normalize(repoName)
  return (
    normalized === 'ai-agents' || normalized === 'enterprise-ai-agent-platform'
  )
}

function isInterop(repoName: string): boolean {
  const normalized = normalize(repoName)
  return (
    normalized === 'interop' ||
    normalized === 'interoperability' ||
    normalized === 'cp-interoperability-monorepo'
  )
}

export function buildRepoRouteCardContext(
  repoName: string,
  taskText: string,
): string | undefined {
  const routeCards = routeCardsForRepo(repoName)
  if (!routeCards) {
    return undefined
  }

  const normalizedTaskText = normalize(taskText)
  const matchingCards = routeCards.filter((card) =>
    card.triggerPhrases.some((phrase) =>
      containsPhrase(normalizedTaskText, phrase),
    ),
  )
  const cards = matchingCards.length > 0 ? matchingCards : routeCards

  return [
    '## Repo Route Cards',
    '',
    'Use these reviewed repo-specific waypoints before broad exploration. They are guidance only; verify paths in the working tree.',
    '',
    ...cards.flatMap((card) => [
      `### ${card.title}`,
      `- Route card: ${card.id}`,
      ...(card.entrypointHints?.length
        ? [
            `- Reviewed entrypoint hints: ${card.entrypointHints.map((item) => `\`${item}\``).join(', ')}`,
          ]
        : []),
      ...card.guidance.map((item) => `- ${item}`),
      '',
    ]),
  ]
    .join('\n')
    .trim()
}

function routeCardsForRepo(repoName: string): RepoRouteCard[] | undefined {
  if (isCoreApp(repoName)) {
    return CORE_APP_ROUTE_CARDS
  }
  if (isAiAgents(repoName)) {
    return AI_AGENTS_ROUTE_CARDS
  }
  if (isInterop(repoName)) {
    return INTEROP_ROUTE_CARDS
  }
  return undefined
}

export function getRepoRouteCardMatches(
  repoName: string,
  taskText: string,
): RepoRouteCard[] {
  const routeCards = routeCardsForRepo(repoName)
  if (!routeCards) {
    return []
  }

  const normalizedTaskText = normalize(taskText)
  return routeCards.filter((card) =>
    card.triggerPhrases.some((phrase) =>
      containsPhrase(normalizedTaskText, phrase),
    ),
  )
}
