import * as XLSX from 'xlsx';
import { BaseScenario } from './BaseScenario.js';
import type { TicketData } from '../types.js';

export class AutoTaskingScenario extends BaseScenario {
  extractTickets(workbook: XLSX.WorkBook, filename: string): TicketData[] {
    const tickets: TicketData[] = [];
    const sheetNames = workbook.SheetNames.filter(s => !this.isIndicatorSheet(s));
    const autoTaskSheet = sheetNames.find(s => {
      const sl = s.toLowerCase();
      return sl.includes('auto task') || sl.includes('auto tasking');
    });
    const sheetName = autoTaskSheet || sheetNames[0] || workbook.SheetNames[0];
    const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    const nonEmptyRows = this.getNonEmptyRows(rows);

    nonEmptyRows.forEach((row, index) => {
      const summary = this.getSummary(row, `Task - Row ${index + 1}`);
      tickets.push({
        summary,
        description: this.buildRowDescription(row),
        issueType: 'Service request',
        sourceRef: `${sheetName}:row-${index}`,
        labels: ['BCAT-created'],
      });
    });

    return tickets;
  }

  getAttachmentBuffer(workbook: XLSX.WorkBook, sourceRef: string): Buffer | null {
    try {
      const [sheetName, rowPart] = sourceRef.split(':');
      const rowIndex = parseInt(rowPart.replace('row-', ''));

      const rawData: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }) as any[][];
      if (rawData.length === 0) return null;

      const header = rawData[0];
      const dataRow = rawData[rowIndex + 1];
      if (!dataRow) return null;

      const newWb = XLSX.utils.book_new();
      const newSheet = XLSX.utils.aoa_to_sheet([header, dataRow]);
      XLSX.utils.book_append_sheet(newWb, newSheet, sheetName);
      return Buffer.from(XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' }));
    } catch {
      return null;
    }
  }
}
