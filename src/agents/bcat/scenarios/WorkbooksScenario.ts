import * as XLSX from 'xlsx';
import { BaseScenario } from './BaseScenario.js';
import type { TicketData } from '../types.js';

export class WorkbooksScenario extends BaseScenario {
  extractTickets(workbook: XLSX.WorkBook, filename: string): TicketData[] {
    const tickets: TicketData[] = [];
    const dataSheets = workbook.SheetNames.filter(s => !this.isIndicatorSheet(s));

    dataSheets.forEach(sheetName => {
      const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      const nonEmptyRows = this.getNonEmptyRows(rows);

      const summary = filename.replace(/\.(xlsx|xls)$/i, '').substring(0, 255);
      const description = nonEmptyRows.length > 0
        ? this.buildRowDescription(nonEmptyRows[0])
        : `Solution Workbook: ${sheetName}`;

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
