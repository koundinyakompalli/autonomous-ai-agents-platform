/**
 * NOTARY Agent — Client Notes Review
 * Barrel exports
 */

export { NOTARYAgent }           from './NOTARYAgent.js';
export { NOTARYJiraService,
         LABEL_REVIEWED_NOTES,
         LABEL_DRAFT_NOTES }     from './NOTARYJiraService.js';
export type {
    NOTARYAgentOptions,
    NOTARYResult,
    NOTARYStructuredSummary,
    TicketRecord,
    TicketClassification,
    TicketProcessingResult,
    NOTARYDraftOutput,
}                                from './types.js';
export { NOTARY_OUTPUT_SCHEMA }  from './types.js';
