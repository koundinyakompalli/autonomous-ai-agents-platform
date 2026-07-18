import * as XLSX from 'xlsx';
import { BaseScenario } from './BaseScenario.js';
import type { TicketData } from '../types.js';

// Fields to exclude from the ticket description
const EXCLUDED_FIELDS_PATTERNS = ['client applicable', 'notes', 'technical enabled'];

/**
 * Normalize a string for flexible matching - handles various line breaks and whitespace
 */
function normalizeString(str: string): string {
  return String(str || '')
    .toLowerCase()
    .replace(/[\r\n]+/g, ' ')  // Replace line breaks with spaces
    .replace(/\s+/g, ' ')       // Collapse multiple spaces
    .trim();
}

/**
 * Find the "Technical Enabled" column in a row - flexible matching
 * Handles various formats: "Technical\r\nEnabled", "Technical\nEnabled", "Technical Enabled"
 */
function findTechnicalEnabledColumn(row: Record<string, any>): string | null {
  for (const key of Object.keys(row)) {
    const normalized = normalizeString(key);
    if (normalized.includes('technical') && normalized.includes('enabled')) {
      return key;
    }
  }
  return null;
}

/**
 * Check if a value indicates "Technical Enabled" status
 * Handles various formats in the cell value
 */
function isTechnicalEnabled(value: any): boolean {
  const normalized = normalizeString(value);
  return normalized.includes('technical') && normalized.includes('enabled');
}

export class UpgradesScenario extends BaseScenario {
  extractTickets(workbook: XLSX.WorkBook, filename: string): TicketData[] {
    const tickets: TicketData[] = [];
    const dataSheets = workbook.SheetNames.filter(s => !this.isIndicatorSheet(s));

    dataSheets.forEach(sheetName => {
      const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      const nonEmptyRows = this.getNonEmptyRows(rows);

      // Find the Technical Enabled column (flexible matching)
      const techEnabledColumn = nonEmptyRows.length > 0 ? findTechnicalEnabledColumn(nonEmptyRows[0]) : null;

      if (!techEnabledColumn) {
        // No Technical Enabled column found in this sheet, skip it
        return;
      }

      // Filter to only rows where Technical Enabled column = "Technical Enabled"
      const techEnabledRows = nonEmptyRows.filter(row => {
        return isTechnicalEnabled(row[techEnabledColumn]);
      });

      // Skip sheets with no Technical Enabled rows
      if (techEnabledRows.length === 0) return;

      const summary = sheetName.substring(0, 255);
      const description = techEnabledRows.map((row, index) => {
        const fields = Object.entries(row)
          .filter(([k, v]) => {
            // Exclude fields based on normalized pattern matching
            const normalizedKey = normalizeString(k);
            const shouldExclude = EXCLUDED_FIELDS_PATTERNS.some(pattern =>
              normalizedKey.includes(pattern)
            );
            return !shouldExclude &&
              !k.startsWith('__EMPTY') &&
              v !== null && v !== undefined && String(v).trim() !== '';
          })
          .map(([k, v]) => `${k.replace(/[\r\n]+/g, ' ')}: ${String(v).replace(/[\r\n]+/g, ' ')}`)
          .join('\n');
        return `Row ${index + 1}:\n${fields}`;
      }).join('\n\n');

      tickets.push({
        summary,
        description,
        issueType: 'Service request',
        sourceRef: sheetName,
        labels: ['BCAT-created'],
      });
    });

    return tickets;
  }

  getAttachmentBuffer(workbook: XLSX.WorkBook, sourceRef: string): Buffer | null {
    // sourceRef is the sheet name
    try {
      const newWb = XLSX.utils.book_new();
      const sheet = workbook.Sheets[sourceRef];
      if (!sheet) return null;
      XLSX.utils.book_append_sheet(newWb, sheet, sourceRef);
      return Buffer.from(XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' }));
    } catch {
      return null;
    }
  }
}
