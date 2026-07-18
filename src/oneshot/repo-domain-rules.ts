import type { CodeRepository } from "../orchestrator/database.js";
import {
  getOneShotRepoMetadata,
  isOneShotRepoEnabled,
} from "./repo-metadata.js";

export interface RepoDomainRuleMatch {
  repo: CodeRepository;
  evidence: string[];
}

export interface RepoDomainRule {
  repoName: string;
  phrases: string[];
}

export const REPO_DOMAIN_RULES: RepoDomainRule[] = [
  {
    repoName: "data-visor",
    phrases: [
      "data lake",
      "data-lake",
      "data visor",
      "datavisor",
      "dv",
      "reference table",
      "reference data",
      "reporting pipeline",
      "data pipeline",
    ],
  },
  {
    repoName: "interop",
    phrases: [
      "interop",
      "interoperability",
      "fhir",
      "da vinci",
      "davinci",
      "cms 0057",
      "cms-0057",
      "cms-0057-f",
      "crd",
      "coverage requirements discovery",
      "dtr",
      "documentation templates and rules",
      "pas",
      "prior authorization support",
      "cds hook",
      "cds-hooks",
      "order sign",
      "order-sign",
      "order select",
      "order-select",
      "order dispatch",
      "order-dispatch",
      "pa list",
      "pa-list",
      "pa needed",
      "pa-needed",
      "doc needed",
      "doc-needed",
      "medpharm",
      "jcode",
      "j-code",
      "line of business",
      "lob",
      "interqual",
      "mcg",
      "healthlake",
      "core rest client",
      "corerestclient",
      "questionnaire package",
      "questionnaire-package",
      "$questionnaire-package",
      "next question",
      "next-question",
      "$next-question",
      "save to mrs",
      "save-to-mrs",
      "$save-to-mrs",
      "claimresponse",
      "claim response",
      "operationoutcome",
      "operation outcome",
      "questionnaireresponse",
      "questionnaire response",
      "documentreference",
      "document reference",
      "external integration",
      "payer api",
      "provider api exchange",
    ],
  },
  {
    repoName: "Document-ai",
    phrases: [
      "document ai",
      "document-ai",
      "ocr",
      "document extraction",
      "document understanding",
      "intake extraction",
      "extracted document",
    ],
  },
  {
    repoName: "Ai-agents",
    phrases: [
      "ai agents",
      "ai-agents",
      "enterprise ai agent platform",
      "enterprise-ai-agent-platform",
      "agent platform",
      "controller agent",
      "controller agents",
      "processing agent",
      "processing agents",
      "agent hosting",
      "host any agents",
      "host agents",
      "mcp server",
      "internal mcp",
      "external mcp",
      "agent orchestration",
      "orchestration core",
      "code intelligence service",
      "code intelligence mcp",
      "atlassian mcp",
      "document360 mcp",
      "ai platform cli",
      "terraform managed agents",
    ],
  },
  {
    repoName: "cp-autonomous-ai-agents-platform",
    phrases: [
      "cp-autonomous-ai-agents-platform",
      "autonomous ai agents platform",
      "specter",
      "oneshot",
      "one shot",
      "oneshot platform",
      "oneshot runtime",
      "specter dashboard",
      "qualifier",
      "planner",
      "repo router",
      "prism",
      "surge",
    ],
  },
  {
    repoName: "batch-jobs",
    phrases: [
      "batch job",
      "batch-jobs",
      "scheduled job",
      "correspondence job",
      "workflow job",
      "assessment job",
      "queue processing",
    ],
  },
  {
    repoName: "provider-portal",
    phrases: [
      "provider portal",
      "provider-portal",
      "provider-facing",
      "provider facing",
    ],
  },
  {
    repoName: "React-based-new-ui",
    phrases: [
      "react ui",
      "react-based-new-ui",
      "smart prominence",
      "cp-mhk-smart-prominence",
      "md review",
      "new ui",
    ],
  },
  {
    repoName: "client-services",
    phrases: [
      "client services",
      "client-services",
      "customer-specific",
      "customer specific implementation",
      "client integration",
    ],
  },
  {
    repoName: "core-app",
    phrases: [
      "member search",
      "membersearch",
      "authorization intake",
      "auth intake",
      "authorizations",
      "core web service",
      "core web-service",
      "mhk core api",
      "medhok web service",
      "medhok-web-services",
      "ws-doc-api",
      "authrestservices",
      "submitpreauth",
      "memberrestservices",
      "fetchmember",
      "wsmemberquery",
      "wspreauthinput",
      "wsquestionset",
      "wsguideline",
      "rxparestservices",
      "getquestionsetrx",
      "getcptcodes",
      "medhokqa-swagger-api-docs",
      "grievance",
      "appeals",
      "care management",
      "smartgwt",
      "gwt",
      "core ui",
      "member banner",
      "case workspace",
      "careprominence",
      "care prominence",
      "der",
      "dercontextmenu",
      "der_request_types",
      "rx case",
      "rx icon",
      "rx cd codes",
      "request type enablement",
      "letter template",
      "approval letter",
      "post-approval case edit",
      "post approval case edit",
    ],
  },
  // Security remediation (PFOS tickets from Wiz/TRIAGE).
  //
  // Primary routing: TRIAGE always embeds an explicit "Repo: <name>" directive
  // in the ticket description. explicit-repo-resolution.ts handles that before
  // domain rules are evaluated, so these rules are a fallback only — they fire
  // when the Repo: directive is somehow absent.
  //
  // Design: one broad phrase per repo that TRIAGE writes into every story it
  // creates, NOT package names (which appear in all repos and would misroute).
  // TRIAGE writes "cp-medhok-monorepo security remediation" / "cp-batch-monorepo
  // security remediation" / "cp-hedis-monorepo security remediation" in the
  // "Where to Update" comment — these phrases are that signal.
  {
    repoName: "cp-medhok-monorepo",
    phrases: [
      "cp-medhok-monorepo security remediation",
      "cp-medhok-monorepo cve",
    ],
  },
  {
    repoName: "cp-batch-monorepo",
    phrases: [
      "cp-batch-monorepo security remediation",
      "cp-batch-monorepo cve",
    ],
  },
  {
    repoName: "cp-hedis-monorepo",
    phrases: [
      "cp-hedis-monorepo security remediation",
      "cp-hedis-monorepo cve",
    ],
  },
];

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[-\s]+/g, "[-\\s]+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function repoMatchesName(repo: CodeRepository, repoName: string): boolean {
  const metadata = getOneShotRepoMetadata(repo);
  return (
    repo.repo_name.toLowerCase() === repoName.toLowerCase() ||
    metadata?.repoName.toLowerCase() === repoName.toLowerCase()
  );
}

export function findDeterministicDomainRepoMatches(
  ticketText: string,
  availableRepos: CodeRepository[],
): RepoDomainRuleMatch[] {
  const enabledRepos = availableRepos.filter(isOneShotRepoEnabled);
  const normalizedText = ticketText.toLowerCase();
  const matches: RepoDomainRuleMatch[] = [];

  for (const rule of REPO_DOMAIN_RULES) {
    const repo = enabledRepos.find((candidate) =>
      repoMatchesName(candidate, rule.repoName),
    );
    if (!repo) {
      continue;
    }

    const evidence = rule.phrases
      .filter((phrase) => containsPhrase(normalizedText, phrase))
      .map(
        (phrase) => `Matched domain phrase "${phrase}" for ${repo.repo_name}.`,
      );

    if (evidence.length > 0) {
      matches.push({ repo, evidence });
    }
  }

  return matches;
}
