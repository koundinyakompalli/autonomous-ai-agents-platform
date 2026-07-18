/**
 * FORGE - Failure Operations Root-cause Guidance Engine
 *
 * Analyzes MP product job failure tickets (MPSUP incidents),
 * identifies root cause, classifies errors, and recommends team routing.
 */

export { FORGEAgent } from "./FORGEAgent.js";
export type {
  FORGEAgentOptions,
  FORGEResult,
  FORGEStructuredOutput,
  FORGEErrorCategory,
  FORGETeamRoute,
  FORGEError,
  ParsedJobContext,
} from "./types.js";
