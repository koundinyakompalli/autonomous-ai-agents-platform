/**
 * Harvey - Conversational Intake Agent
 *
 * Shared types for the Harvey service
 */

/**
 * Chat session persisted in the database
 */
export interface ChatSession {
  id: number;
  session_id: string;
  user_id: string;
  user_name: string;
  channel: 'teams' | 'web';
  status: ChatSessionStatus;
  resolved_agent_id: number | null;
  resolved_customer_id: number | null;
  resolved_repo_ids: string | null;
  task_management_id: number | null;
  jira_number: string | null;
  conversation_reference: any | null;
  messages_json: ChatMessage[];
  /** Compact summary written at session close, injected into the next session as context */
  summary: string | null;
  created_at: Date;
  updated_at: Date;
}

export type ChatSessionStatus =
  | 'active'
  | 'routing'
  | 'task_created'
  | 'delivering'
  | 'completed'
  | 'delivered'
  | 'abandoned';

/**
 * A single message in the conversation
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

/**
 * Response from the IntakeAgent after processing a user message
 */
export interface IntakeResponse {
  /** Text to send back to the user */
  reply: string;
  /** Whether a task was created as a result of this message */
  taskCreated: boolean;
  /** Task management ID if created */
  taskManagementId?: number;
  /** Agent that will handle the task */
  agentName?: string;
  /** Whether the agent wants to end the session */
  sessionComplete: boolean;
}

/**
 * Result delivered back to the user after agent processing completes
 */
export interface DeliveryPayload {
  sessionId: string;
  taskManagementId: number;
  agentName: string;
  jiraNumber: string | null;
  success: boolean;
  /** Summary for the Teams message (truncated) */
  summary: string;
  /** Full result markdown */
  fullResult: string;
  metrics?: {
    durationSeconds: number;
    cost: string;
    tokensConsumed: string;
  };
}

/**
 * Streaming callbacks for Teams integration
 */
export interface StreamCallbacks {
  /** Called when the agent produces text to show the user */
  onReply: (text: string) => Promise<void>;
  /** Called when a task is created */
  onTaskCreated?: (taskManagementId: number, agentName: string) => Promise<void>;
}

/**
 * Harvey service configuration
 */
export interface HarveyConfig {
  /** Microsoft App ID for the Teams bot */
  teamsAppId: string;
  /** Microsoft App Password for the Teams bot */
  teamsAppPassword: string;
  /** Port for the HTTP server (Bot Framework messages endpoint) */
  port: number;
  /** Host to bind to */
  host: string;
  /** Polling interval for result delivery (ms) */
  resultPollIntervalMs: number;
  /** AWS region */
  awsRegion: string;
}
