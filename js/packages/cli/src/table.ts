import { printable } from './printable.js';

/** Columns padded to their widest cell, measured as the terminal shows it. */
export function table(cells: string[][]): string {
  const rows = cells.map((row) => row.map(printable));
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}
