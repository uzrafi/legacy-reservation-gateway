/** Legacy-host-internal wire formats. The gateway has its own copy in src/adapter/codes.ts on purpose. */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "14NOV26" -> Date (UTC midnight), or undefined when malformed. */
export function parseLegacyDate(s: string): Date | undefined {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(s);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[2]!);
  if (month < 0) return undefined;
  const day = Number(m[1]);
  const year = 2000 + Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCDate() !== day) return undefined; // e.g. 31FEB26
  return d;
}

export function formatLegacyDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${dd}${MONTHS[d.getUTCMonth()]}${yy}`;
}

/** Timestamp like "14NOV26 1432Z". */
export function formatLegacyTimestamp(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatLegacyDate(d)} ${hh}${mi}Z`;
}

export function padCode(s: string, width: number): string {
  return s.padEnd(width, ' ');
}

export function formatAmount(cents: number): string {
  return String(cents).padStart(7, '0');
}
