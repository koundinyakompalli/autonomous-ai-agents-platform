/**
 * Hook type definitions for Claude Agent SDK.
 *
 * Prior to 2026-04-18 this module also exported factory functions
 * (makeDenyWritesOutsideRepos, makeDenyDangerousCommands,
 * makeReadOnlyHook, makeAuditLogHook, makeRateLimitHook,
 * makeTimeoutHook, makeWebhookHook, makeProgressHook, buildHooks)
 * plus a HooksConfig aggregator shape. None of them were wired into
 * sdkOptions.hooks: PR #58 hard-coded observability hooks inline in
 * index.ts (SDK_NOTIFICATION, SDK_TOOL_FAILURE) and bypassed
 * buildHooks entirely, so the factories became unreachable dead code.
 *
 * They have been deleted. The remaining type exports are the ones
 * still consumed by src/claude-sdk/index.ts and downstream agents
 * (ProgressUpdate, AuditLogEvent) plus the SDK-facing callback
 * contract (HookInput, HookOutput, HookCallback) that documents the
 * shape of the inline hooks in index.ts.
 *
 * If audit logging or policy hooks are needed again, add a single
 * focused helper here and wire it into the inline hook array in
 * index.ts - do not resurrect a generic buildHooks aggregator.
 */

/**
 * Hook callback input structure
 */
export interface HookInput {
    hook_event_name: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    session_id?: string;
    message_id?: string;
}

/**
 * Hook callback output structure
 */
export interface HookOutput {
    hookSpecificOutput?: {
        hookEventName: string;
        permissionDecision?: 'allow' | 'deny';
        permissionDecisionReason?: string;
        modifiedToolInput?: Record<string, unknown>;
    };
}

/**
 * Hook callback type
 */
export type HookCallback = (
    input: HookInput,
    toolUseId: string,
    context: { signal?: AbortSignal }
) => Promise<HookOutput>;

/**
 * Audit log event structure
 */
export interface AuditLogEvent {
    timestamp: string;
    toolUseId: string;
    hookEvent: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    sessionId?: string;
}

/**
 * Progress callback for streaming updates
 */
export interface ProgressUpdate {
    type: 'tool_start' | 'tool_end' | 'thinking' | 'iteration' | 'result';
    toolName?: string;
    message?: string;
    iteration?: number;
    elapsed?: number;
    success?: boolean;
}
