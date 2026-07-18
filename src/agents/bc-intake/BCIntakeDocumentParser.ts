/**
 * BC Upgrade Intake Form Document Parser
 *
 * Parses Word/DOCX documents containing BC Upgrade intake forms
 * Extracts mandatory field values using deterministic text matching
 */

import mammoth from 'mammoth';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../utils/logger.js';
import type { IntakeFormFields, DocumentParseResult } from './types.js';

const logger = createLogger('bc-intake-parser');

export class BCIntakeDocumentParser {
    /**
     * Parse a Word document and extract intake form fields
     *
     * @param filePath - Absolute path to the .docx file
     * @returns Parsed fields and validation status
     */
    async parseDocument(filePath: string): Promise<DocumentParseResult> {
        const fileName = path.basename(filePath);
        const logContext = { fileName, filePath };

        logger.info(logContext, '[BC_INTAKE_PARSE_START] Starting document parse');

        try {
            // Read the DOCX file
            const buffer = await fs.promises.readFile(filePath);

            // Extract text using mammoth
            const result = await mammoth.extractRawText({ buffer });
            const rawText = result.value;

            logger.debug({
                ...logContext,
                textLength: rawText.length,
            }, '[BC_INTAKE_PARSE_EXTRACTED] Text extracted from document');

            // Parse fields from text
            const fields = this.extractFields(rawText);

            const fieldCount = Object.values(fields).filter(v => v && v.trim().length > 0).length;

            logger.info({
                ...logContext,
                fieldCount,
                fields: Object.keys(fields).filter(k => fields[k as keyof IntakeFormFields]),
            }, '[BC_INTAKE_PARSE_SUCCESS] Document parsed successfully');

            return {
                success: true,
                fileName,
                fields,
                rawText,
            };
        } catch (error: any) {
            logger.error({
                ...logContext,
                error: error.message,
                errorStack: error.stack,
            }, '[BC_INTAKE_PARSE_ERROR] Failed to parse document');

            return {
                success: false,
                fileName,
                fields: {},
                error: error.message,
            };
        }
    }

    /**
     * Extract field values from raw text using pattern matching
     *
     * Looks for field labels followed by their values
     */
    private extractFields(text: string): IntakeFormFields {
        const fields: IntakeFormFields = {};

        // Normalize text: collapse multiple whitespaces, trim lines
        const normalizedText = text
            .split('\n')
            .map(line => line.trim())
            .join('\n');

        // Field patterns: label followed by value (on same or next line)
        const patterns = {
            module: /Module[\s:]*([^\n]+)/i,
            severityLevel: /Severity[\s]*Level[\s:]*([^\n]+)/i,
            environment: /Environment[\s:]*([^\n]+)/i,
            testCaseDescription: /Test[\s]*Case[\s]*Description[\s/]*Scenario[\s:]*([^\n]+(?:\n(?!.*:)[^\n]+)*)/i,
            caseNumber: /Case[\s]*#?[\s]*Number?[\s:]*([^\n]+)/i,
            memberId: /Member[\s]*ID[\s]*#?[\s:]*([^\n]+)/i,
            applicableTestData: /Applicable[\s]*[Tt]est[\s]*[Dd]ata[\s:]*([^\n]+(?:\n(?!.*:)[^\n]+)*)/i,
            stepsToReproduce: /Steps[\s]*[Tt]o[\s]*[Rr]eproduce[\s:]*([^\n]+(?:\n(?!.*:)[^\n]+)*)/i,
            expectedResults: /Expected[\s]*Results?[\s:]*([^\n]+(?:\n(?!.*:)[^\n]+)*)/i,
            actualResults: /Actual[\s]*Results?[\s:]*([^\n]+(?:\n(?!.*:)[^\n]+)*)/i,
        };

        // Extract each field
        for (const [fieldKey, pattern] of Object.entries(patterns)) {
            const match = normalizedText.match(pattern);
            if (match && match[1]) {
                let value = match[1].trim();

                // Clean up value
                value = this.cleanFieldValue(value);

                if (value && value.length > 0) {
                    fields[fieldKey as keyof IntakeFormFields] = value;
                }
            }
        }

        // Special handling: try alternative patterns if primary didn't match
        if (!fields.caseNumber) {
            const altCasePattern = /Case[\s]*Number[\s:]*([^\n]+)/i;
            const match = normalizedText.match(altCasePattern);
            if (match && match[1]) {
                fields.caseNumber = this.cleanFieldValue(match[1]);
            }
        }

        if (!fields.memberId) {
            const altMemberPattern = /Member[\s]*ID[\s]*Number[\s:]*([^\n]+)/i;
            const match = normalizedText.match(altMemberPattern);
            if (match && match[1]) {
                fields.memberId = this.cleanFieldValue(match[1]);
            }
        }

        return fields;
    }

    /**
     * Clean and normalize field value
     *
     * - Remove extra whitespace
     * - Remove common placeholder text
     * - Trim special characters
     */
    private cleanFieldValue(value: string): string {
        // Collapse multiple whitespace
        value = value.replace(/\s+/g, ' ').trim();

        // Remove placeholder text patterns
        const placeholders = [
            /^\[.*?\]$/,  // [placeholder]
            /^<.*?>$/,    // <placeholder>
            /^__+$/,      // ______
            /^\.\.\.+$/,  // ...
            /^N\/A$/i,    // N/A
            /^None$/i,    // None
            /^TBD$/i,     // TBD
        ];

        for (const placeholder of placeholders) {
            if (placeholder.test(value)) {
                return '';
            }
        }

        // Remove leading/trailing punctuation except periods in sentences
        value = value.replace(/^[:\-\s]+/, '').replace(/[:\s]+$/, '');

        return value;
    }

    /**
     * Validate if extracted fields meet minimum requirements
     *
     * @param fields - Extracted fields
     * @returns True if at least 5 fields are present
     */
    validateMinimumFields(fields: IntakeFormFields): boolean {
        const filledFields = Object.values(fields).filter(
            v => v && v.trim().length > 0
        );
        return filledFields.length >= 5;
    }
}
