import * as XLSX from 'xlsx';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('bcat-excel-service');

export class ExcelService {
  parseWorkbook(buffer: Buffer): XLSX.WorkBook {
    return XLSX.read(buffer, { type: 'buffer' });
  }

  getSheetNames(workbook: XLSX.WorkBook): string[] {
    return workbook.SheetNames;
  }

  getSheetData(workbook: XLSX.WorkBook, sheetName: string): Record<string, any>[] {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }

  getSheetRawData(workbook: XLSX.WorkBook, sheetName: string): any[][] {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
  }

  /**
   * Create an Excel buffer containing a single sheet from the original workbook
   */
  createSheetExcel(workbook: XLSX.WorkBook, sheetName: string): Buffer {
    const newWb = XLSX.utils.book_new();
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet '${sheetName}' not found`);
    XLSX.utils.book_append_sheet(newWb, sheet, sheetName);
    return Buffer.from(XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' }));
  }

  /**
   * Create an Excel buffer containing a single row (header + data row) from a sheet
   */
  createRowExcel(workbook: XLSX.WorkBook, sheetName: string, rowIndex: number): Buffer {
    const rawData = this.getSheetRawData(workbook, sheetName);
    if (rawData.length === 0) throw new Error(`Sheet '${sheetName}' is empty`);

    const header = rawData[0];
    const dataRow = rawData[rowIndex + 1]; // +1 because rawData[0] is header
    if (!dataRow) throw new Error(`Row ${rowIndex} not found in sheet '${sheetName}'`);

    const newWb = XLSX.utils.book_new();
    const newSheet = XLSX.utils.aoa_to_sheet([header, dataRow]);
    XLSX.utils.book_append_sheet(newWb, newSheet, sheetName);
    return Buffer.from(XLSX.write(newWb, { type: 'buffer', bookType: 'xlsx' }));
  }
}
