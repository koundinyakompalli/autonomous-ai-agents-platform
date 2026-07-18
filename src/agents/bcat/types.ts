export enum ScenarioType {
  LETTERS = 'LETTERS',
  ASSESSMENTS = 'ASSESSMENTS',
  UPGRADES = 'UPGRADES',
  WORKBOOKS = 'WORKBOOKS',
  AUTO_TASKING = 'AUTO_TASKING',
  UNKNOWN = 'UNKNOWN',
}

export interface TicketData {
  summary: string;
  description: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  customFields?: Record<string, any>;
  // Row index or sheet name for reference
  sourceRef: string;
}

export interface BCATAttachment {
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

export interface BCATResult {
  success: boolean;
  ticketsCreated?: Array<{
    jiraKey: string;
    summary: string;
    sourceRef: string;
  }>;
  error?: string;
}

export interface WorkbookData {
  buffer: Buffer;
  filename: string;
  sheetNames: string[];
}
