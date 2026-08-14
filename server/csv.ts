/**
 * Общее для выгрузок в CSV. Excel на русской локали ждёт «;» разделителем,
 * запятую в дробной части и BOM в начале файла — иначе кириллица приезжает
 * кракозябрами, а числа становятся текстом.
 */

/** Тиыны → «1234,56». Единственное место, где сервер делит на 100. */
export function csvMoney(minor: number): string {
  return (minor / 100).toFixed(2).replace('.', ',');
}

/** Экранирование ячейки: кавычки, «;» и переводы строк. */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(';');
}

/** Готовое тело файла: BOM для Excel и CRLF между строками. */
export function csvBody(rows: string[]): string {
  return '﻿' + rows.join('\r\n');
}
