/** RFC 4180 escaping, plus a guard against spreadsheet formula injection for text values. */
export function csvEscape(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvLine(values: Array<string | number>): string {
  return `${values.map(csvEscape).join(',')}\r\n`;
}
