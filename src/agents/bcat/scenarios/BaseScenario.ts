import type * as XLSX from 'xlsx';
import type { TicketData } from '../types.js';

export abstract class BaseScenario {
  /**
   * Extract ticket data from the workbook
   */
  abstract extractTickets(workbook: XLSX.WorkBook, filename: string): TicketData[];

  /**
   * Get attachment buffer for a specific ticket (by index/ref)
   * Returns null if this scenario type has no per-ticket attachments
   */
  abstract getAttachmentBuffer(workbook: XLSX.WorkBook, sourceRef: string): Buffer | null;

  /**
   * Get the name of sheets to skip (indicator/instruction sheets)
   */
  protected isIndicatorSheet(sheetName: string): boolean {
    const lower = sheetName.toLowerCase();
    return lower.includes('indicator') || lower === 'sheet1' || lower === 'instructions' || lower === 'readme';
  }

  /**
   * Get non-empty rows from sheet data
   */
  protected getNonEmptyRows(rows: Record<string, any>[]): Record<string, any>[] {
    return rows.filter(row => {
      const values = Object.values(row);
      return values.some(v => v !== null && v !== undefined && v !== '');
    });
  }

  /**
   * Build description text from row data
   */
  protected buildRowDescription(row: Record<string, any>): string {
    return Object.entries(row)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }

  /**
   * Get summary field from a row - tries common field names
   */
  protected getSummary(row: Record<string, any>, fallback: string): string {
    const summaryFields = ['Summary', 'summary', 'Title', 'title', 'Name', 'name', 'Subject', 'subject', 'Description', 'Issue', 'Task'];
    for (const field of summaryFields) {
      if (row[field] && String(row[field]).trim()) {
        return String(row[field]).trim().substring(0, 255);
      }
    }
    return fallback;
  }
}
