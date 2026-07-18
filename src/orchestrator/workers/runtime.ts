import type { AgentWorker } from "../AgentWorker.js";

export type AgentWorkerConstructor = new (
  repositoryPath: string,
  enableStatusServer?: boolean,
) => AgentWorker;

// Keep the built-in worker mapping and normalization rules in sync with
// .github/scripts/resolve-worker-entry.py. The workflows use that helper to
// validate worker source resolution before Terraform activation.

interface WorkerModuleSpec {
  description: string;
  exportName: string;
  moduleStem: string;
}

const BUILTIN_WORKERS: Record<string, WorkerModuleSpec> = {
  DARCI: {
    description: "Defect Analysis & Root Cause Identification",
    exportName: "DARCIWorker",
    moduleStem: "DARCI",
  },
  SCRIBE: {
    description:
      "Simple Clear Rundown of Implementations, Behavior, and Endpoints",
    exportName: "SCRIBEWorker",
    moduleStem: "SCRIBE",
  },
  PRISM: {
    description: "Planning & Refinement with Intelligent Systems at MedHok",
    exportName: "PRISMWorker",
    moduleStem: "PRISM",
  },
  QUALIFIER: {
    description: "PFOS Qualification & OneShot Control-Plane Entry",
    exportName: "QualifierWorker",
    moduleStem: "Qualifier",
  },
  HERMES: {
    description: "Heuristic Engine for Rules, Modes, and Environment Settings",
    exportName: "HERMESWorker",
    moduleStem: "HERMES",
  },
  SENTRY: {
    description: "Safety & Execution eNtry Risk analYzer",
    exportName: "SENTRYWorker",
    moduleStem: "SENTRY",
  },
  BEACON: {
    description: "Backend Execution Agent for Case Orchestrated Normalization",
    exportName: "BEACONWorker",
    moduleStem: "BEACON",
  },
  MERIDIAN: {
    description:
      "Managed Evaluation & Resolution Intelligence for Data Investigation, Analysis and Normalization",
    exportName: "MERIDIANWorker",
    moduleStem: "MERIDIAN",
  },
  "BC-INTAKE": {
    description: "BC Upgrade Ticket Validation",
    exportName: "BCIntakeWorker",
    moduleStem: "BCIntake",
  },
  "BCAT-PLANNER": {
    description: "Bulk Create And Track (Planning Phase)",
    exportName: "BCATplannerWorker",
    moduleStem: "BCATplanner",
  },
  "BCAT-EXECUTOR": {
    description: "Bulk Create And Track (Execution Phase)",
    exportName: "BCATExecutorWorker",
    moduleStem: "BCATExecutor",
  },
  VERITAS: {
    description:
      "Verified Evidence-based Root-cause Investigation Truth & Analysis System",
    exportName: "VERITASWorker",
    moduleStem: "VERITAS",
  },
  ANVIL: {
    description: "Automated Normalization of YAML from Implementation Layouts",
    exportName: "ANVILWorker",
    moduleStem: "ANVIL",
  },
  NOTARY: {
    description: "Client Notes Review Agent",
    exportName: "NOTARYWorker",
    moduleStem: "NOTARY",
  },
  SRLOG: {
    description: "SQL & Resource LOG Analyzer",
    exportName: "SRLOGWorker",
    moduleStem: "SRLOG",
  },
  FORGE: {
    description: "Failure Operations Root-cause Guidance Engine",
    exportName: "FORGEWorker",
    moduleStem: "FORGE",
  },
  LEDGER: {
    description: "Level-of-Effort Data Guidance Estimation Reporter",
    exportName: "LEDGERWorker",
    moduleStem: "LEDGER",
  },
  RIFT: {
    description: "Regression Investigation & Fix Tracker",
    exportName: "RIFTWorker",
    moduleStem: "RIFT",
  },
};

interface WorkerModuleCandidate {
  exportName: string;
  moduleStem: string;
}

export function normalizeWorkerType(workerType: string): string {
  return workerType
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .toUpperCase();
}

function toPascalCase(words: string[]): string {
  return words
    .map((word) => {
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function buildWorkerModuleCandidates(
  workerType: string,
): WorkerModuleCandidate[] {
  const normalized = normalizeWorkerType(workerType);
  const candidates: WorkerModuleCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (moduleStem: string, exportName: string): void => {
    if (!moduleStem) {
      return;
    }

    const key = `${moduleStem}:${exportName}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({ moduleStem, exportName });
  };

  const builtin = BUILTIN_WORKERS[normalized];
  if (builtin) {
    addCandidate(builtin.moduleStem, builtin.exportName);
  }

  const words = normalized.split(/[^A-Z0-9]+/).filter(Boolean);
  if (words.length === 0) {
    return candidates;
  }

  const pascalStem = toPascalCase(words);
  const upperStem = words.join("");

  addCandidate(pascalStem, `${pascalStem}Worker`);
  addCandidate(upperStem, `${upperStem}Worker`);

  return candidates;
}

function isModuleResolutionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Cannot find module") ||
    error.message.includes("ERR_MODULE_NOT_FOUND")
  );
}

export async function loadWorkerConstructor(
  workerType: string,
): Promise<AgentWorkerConstructor> {
  const normalized = normalizeWorkerType(workerType);
  const candidates = buildWorkerModuleCandidates(normalized);
  const attemptedModules: string[] = [];
  let lastLoadError: Error | null = null;

  for (const candidate of candidates) {
    attemptedModules.push(`${candidate.moduleStem}Worker.js`);

    try {
      const workerModule = await import(`./${candidate.moduleStem}Worker.js`);
      const exportedConstructor =
        workerModule[candidate.exportName] ?? workerModule.default;

      if (typeof exportedConstructor === "function") {
        return exportedConstructor as AgentWorkerConstructor;
      }

      lastLoadError = new Error(
        `Module ${candidate.moduleStem}Worker.js does not export ${candidate.exportName} or default`,
      );
    } catch (error) {
      if (isModuleResolutionError(error)) {
        continue;
      }

      lastLoadError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const builtins = getBuiltInWorkerTypes().join(", ");
  const attempted =
    attemptedModules.length > 0 ? attemptedModules.join(", ") : "none";
  const errorSuffix = lastLoadError
    ? ` Last load error: ${lastLoadError.message}`
    : "";

  throw new Error(
    `Unknown worker type: ${workerType}. Built-in workers: ${builtins}. ` +
      `Tried module candidates: ${attempted}. ` +
      "Custom workers must provide a matching file in src/orchestrator/workers " +
      "(for example MyAgentWorker.ts exporting MyAgentWorker or default)." +
      errorSuffix,
  );
}

export async function createWorker(
  workerType: string,
  repositoryPath: string,
  enableStatusServer: boolean = false,
): Promise<AgentWorker> {
  const WorkerClass = await loadWorkerConstructor(workerType);
  return new WorkerClass(repositoryPath, enableStatusServer);
}

export function getBuiltInWorkerTypes(): string[] {
  return Object.keys(BUILTIN_WORKERS);
}

export function getWorkerDescription(workerType: string): string {
  const normalized = normalizeWorkerType(workerType);
  return (
    BUILTIN_WORKERS[normalized]?.description ?? `Custom worker (${normalized})`
  );
}
