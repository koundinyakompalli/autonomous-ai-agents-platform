/**
 * BC-INTAKE Agent Types
 *
 * Types for BC Upgrade ticket validation
 */

import type { EventEmitter } from 'events';

/**
 * Configuration options for BCIntakeAgent
 */
export interface BCIntakeAgentOptions {
    /** JIRA username from agent DB record */
    jiraUsername?: string;
    /** JIRA API token from agent DB record */
    jiraToken?: string;
    /** Repository path (optional - BC-INTAKE doesn't need repos) */
    repositoryPath?: string;
    /** Progress callback */
    onProgress?: (message: string) => void;
    /** Event emitter for real-time updates */
    eventEmitter?: EventEmitter;
    /** Timeout in milliseconds (default: 10 minutes) */
    timeoutMs?: number;
}

/**
 * Mandatory fields from BC Upgrade intake form
 */
export interface IntakeFormFields {
    module?: string;
    severityLevel?: string;
    environment?: string;
    testCaseDescription?: string;
    caseNumber?: string;
    memberId?: string;
    applicableTestData?: string;
    stepsToReproduce?: string;
    expectedResults?: string;
    actualResults?: string;
}

/**
 * Validation status for each field
 */
export interface FieldValidation {
    field: string;
    completed: boolean;
    value?: string;
    reason?: string; // 'Missing from form' | 'Not found in document'
}

/**
 * Document parsing result
 */
export interface DocumentParseResult {
    success: boolean;
    fileName: string;
    fields: IntakeFormFields;
    rawText?: string;
    error?: string;
}

/**
 * Ticket validation result
 */
export interface TicketValidationResult {
    isComplete: boolean;
    completedFields: FieldValidation[];
    missingFields: FieldValidation[];
    totalFields: number;
    completedCount: number;
    sourceDocument?: string;
}

/**
 * Configuration Start Date calculation
 */
export interface ConfigurationDateResult {
    date: string; // YYYY-MM-DD format
    reason: string; // 'Before 3pm EST: Today' | 'After 3pm EST: Tomorrow'
}

/**
 * Final agent result
 */
export interface BCIntakeResult {
    success: boolean;
    jiraNumber: string;
    validation: TicketValidationResult;
    actionsT: {
        postedToAINote?: boolean;
        aiNoteField?: string;
        commentPosted?: boolean;
        labelsAdded?: string[];
        labelAdded?: boolean;
        configDateSet?: boolean;
        estimatedCompletionDateSet?: boolean;
    };
    configurationStartDate?: string;
    estimatedCompletionDate?: string;
    error?: string;
    metrics: {
        durationMs: number;
        documentParsed: boolean;
        fieldsValidated: number;
    };
}

/**
 * Reporter filtering rules
 */
export const SKIP_REPORTERS = [
    'rory', 'mcdonald',
    'michelle', 'fonseca',
    'kate', 'johnson', 'land',
    'tianna', 'lima',
    'laina', 'barnes',
    'jayel', 'baker',
    'samantha', 'samatha', 'mulheron'
];

/**
 * Valid environment prefixes for filtering
 *
 * NOTE: Environment filtering is DISABLED (2026-06-02)
 * Agent now processes all BC Upgrade tickets regardless of Target Environment
 * This constant is retained for reference but not actively used
 *
 * Previously filtered to: CONFIG, UAT, PROD
 * Now accepts: All environments (STAGE, DEV, UAT, CONFIG, PROD, etc.)
 */
export const VALID_ENVIRONMENTS = ['config', 'uat', 'prod']; // UNUSED - Filtering disabled

/**
 * JIRA custom field IDs for BC Upgrade intake
 */
export const JIRA_FIELD_IDS = {
    MODULE: 'customfield_10100',
    SEVERITY: 'customfield_10101',
    ENVIRONMENT: 'customfield_10102',
    TEST_CASE_DESC: 'customfield_10103',
    CASE_NUMBER: 'customfield_10104',
    MEMBER_ID: 'customfield_10105',
    TEST_DATA: 'customfield_10106',
    STEPS_TO_REPRODUCE: 'customfield_10108',
    EXPECTED_RESULTS: 'customfield_10109',
    ACTUAL_RESULTS: 'customfield_10110',
    CONFIGURATION_START_DATE: 'customfield_10114',
    ESTIMATED_COMPLETION_DATE: 'customfield_10115',
    // AI Agent Notes tab fields
    AI_NOTE_1: 'customfield_12197',
    AI_NOTE_2: 'customfield_12198',
    AI_NOTE_3: 'customfield_12199',
    AI_NOTE_4: 'customfield_12200',
    AI_NOTE_5: 'customfield_12201',
};

/**
 * AI Note fields in order of preference
 */
export const AI_NOTE_FIELDS = [
    { name: 'AI Note 1', fieldId: JIRA_FIELD_IDS.AI_NOTE_1 },
    { name: 'AI Note 2', fieldId: JIRA_FIELD_IDS.AI_NOTE_2 },
    { name: 'AI Note 3', fieldId: JIRA_FIELD_IDS.AI_NOTE_3 },
    { name: 'AI Note 4', fieldId: JIRA_FIELD_IDS.AI_NOTE_4 },
    { name: 'AI Note 5', fieldId: JIRA_FIELD_IDS.AI_NOTE_5 },
];

/**
 * Mandatory field names (display names)
 */
export const MANDATORY_FIELD_NAMES = [
    'Module',
    'Severity Level',
    'Environment',
    'Test Case Description',
    'Case #',
    'Member ID',
    'Applicable Test Data',
    'Steps to Reproduce',
    'Expected Results',
    'Actual Results',
];
