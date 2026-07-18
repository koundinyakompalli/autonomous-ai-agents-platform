import * as XLSX from 'xlsx';
import { BaseScenario } from './BaseScenario.js';
import type { TicketData } from '../types.js';

export class LettersScenario extends BaseScenario {
  extractTickets(workbook: XLSX.WorkBook, filename: string): TicketData[] {
    const tickets: TicketData[] = [];
    const sheetNames = workbook.SheetNames.filter(s => !this.isIndicatorSheet(s));

    // Use first non-indicator sheet
    const sheetName = sheetNames[0] || workbook.SheetNames[0];
    const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    const nonEmptyRows = this.getNonEmptyRows(rows);

    nonEmptyRows.forEach((row, index) => {
      const summary = this.getSummary(row, `Letter - Row ${index + 1}`);
      tickets.push({
        summary,
        description: this.buildRowDescription(row),
        issueType: 'Service request',
        sourceRef: `row-${index + 1}`,
        labels: ['BCAT-created'],
      });
    });

    return tickets;
  }

  getAttachmentBuffer(_workbook: XLSX.WorkBook, _sourceRef: string): Buffer | null {
    // Letters scenario: no per-ticket attachment
    return null;
  }
}
