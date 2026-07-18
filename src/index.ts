/**
 * Specter - AI Agent Cluster
 *
 * A collection of specialized AI agents powered by Claude Agent SDK
 * with Amazon Bedrock.
 *
 * @example
 * ```typescript
 * import { DARCIAgent, SCRIBEAgent, HERMESAgent, PRISMAgent } from 'specter';
 *
 * // Defect analysis
 * const darci = new DARCIAgent({ repositoryPath: '/repo' });
 * const analysis = await darci.analyze('Login fails after password reset', repoIds);
 *
 * // Code explanation
 * const scribe = new SCRIBEAgent({ repositoryPath: '/repo' });
 * const explanation = await scribe.explain('How does auth work?');
 *
 * // Config lookup
 * const hermes = new HERMESAgent({ repositoryPath: '/repo' });
 * const config = await hermes.findConfig('database.timeout');
 * ```
 */

// =============================================================================
// AGENTS
// =============================================================================

export * from './agents/index.js';

// =============================================================================
// CLAUDE AGENT SDK (for custom agents)
// =============================================================================

export {
  runAgent,
  createAgentRunner,
  registerRepoFromPath,
  registerCustomerWorkspace,
  initReposFromEfs,
  getAgentPrompt,
  AGENT_PROMPTS,
  type AgentRunnerOptions,
  type AgentResult,
} from './claude-sdk/index.js';

// =============================================================================
// CLAUDE SDK CONFIGURATION (for custom agents)
// =============================================================================

export {
  TOOL_SETS,
  getToolSet,
  getOutputSchema,
  getBedrockEnv,
  registerRepo,
  deregisterRepo,
  getRepoPath,
  getRegisteredRepos,
  type ToolPermissionLevel,
  type AgentType,
  type BedrockConfig,
} from './claude-sdk/config.js';

// =============================================================================
// CLAUDE SDK HOOK TYPES (for custom agents)
// =============================================================================
// Note: factory functions (buildHooks, makeDenyWritesOutsideRepos, etc.) were
// removed on 2026-04-18 - they were never wired into sdkOptions.hooks. See
// src/claude-sdk/hooks.ts for history. Only type exports remain.

export type {
  ProgressUpdate,
  AuditLogEvent,
} from './claude-sdk/hooks.js';

// =============================================================================
// UTILITIES
// =============================================================================

export { createLogger } from './utils/logger.js';

// =============================================================================
// INVESTIGATION PLATFORM
// =============================================================================

export * from './investigation/index.js';

// =============================================================================
// VERSION
// =============================================================================

export const VERSION = '2.0.0';
