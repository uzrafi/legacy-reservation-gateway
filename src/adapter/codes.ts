/**
 * Anti-corruption layer, part 1: value mapping between the gateway's clean
 * domain values and RESLINK/2 wire conventions. Pure functions, unit tested
 * against recorded fixtures (test/fixtures).
 */
import type { HoldStatus, SeatStatus } from '../domain';

export class LegacyFormatError extends Error {
  override name = 'LegacyFormatError';
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// --- airports: "YYZ" <-> "YYZ  " (5-char, space padded) ----------------------
export function toLegacyAirport(code: string): string {
  return code.toUpperCase().padEnd(5, ' ');
}
export function fromLegacyAirport(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new LegacyFormatError(`bad airport code from legacy: ${JSON.stringify(raw)}`);
  return code;
}

// --- flight numbers: "AC105" <-> "AC0105" ----------------------------------
export function toLegacyFlight(flightNumber: string): string {
  const m = /^([A-Z]{2})0*(\d{1,4})$/.exec(flightNumber.toUpperCase());
  if (!m) throw new LegacyFormatError(`bad flight number: ${flightNumber}`);
  return `${m[1]}${m[2]!.padStart(4, '0')}`;
}
export function fromLegacyFlight(raw: string): string {
  const m = /^([A-Z]{2})(\d{4})$/.exec(raw.trim());
  if (!m) throw new LegacyFormatError(`bad flight number from legacy: ${JSON.stringify(raw)}`);
  return `${m[1]}${Number(m[2])}`;
}

// --- dates: "2026-11-14" <-> "14NOV26" ---------------------------------------
export function toLegacyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new LegacyFormatError(`bad ISO date: ${iso}`);
  const year = Number(m[1]);
  if (year < 2000 || year > 2099) throw new LegacyFormatError(`year out of legacy range: ${iso}`);
  return `${m[3]}${MONTHS[Number(m[2]) - 1]}${m[1]!.slice(2)}`;
}
export function fromLegacyDate(raw: string): string {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(raw.trim().toUpperCase());
  const month = m ? MONTHS.indexOf(m[2]!) : -1;
  if (!m || month < 0) throw new LegacyFormatError(`bad legacy date: ${JSON.stringify(raw)}`);
  return `20${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]}`;
}

/** "14NOV26 1432Z" -> "2026-11-14T14:32:00.000Z" */
export function fromLegacyTimestamp(raw: string): string {
  const m = /^(\d{2}[A-Z]{3}\d{2}) (\d{2})(\d{2})Z$/.exec(raw.trim());
  if (!m) throw new LegacyFormatError(`bad legacy timestamp: ${JSON.stringify(raw)}`);
  return new Date(`${fromLegacyDate(m[1]!)}T${m[2]}:${m[3]}:00Z`).toISOString();
}

// --- money: "0042900" (integer cents, zero padded, in a string) <-> 42900 -----
export function fromLegacyAmount(raw: string): number {
  const s = raw.trim();
  if (!/^\d{1,9}$/.test(s)) throw new LegacyFormatError(`bad legacy amount: ${JSON.stringify(raw)}`);
  return Number(s);
}
export function toLegacyAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new LegacyFormatError(`bad amount: ${cents}`);
  return String(cents).padStart(7, '0');
}

// --- seats: "12A" <-> "012A" -------------------------------------------------
export function toLegacySeat(seat: string): string {
  const m = /^(\d{1,3})([A-F])$/.exec(seat.toUpperCase());
  if (!m) throw new LegacyFormatError(`bad seat: ${seat}`);
  return `${m[1]!.padStart(3, '0')}${m[2]}`;
}
export function fromLegacySeat(raw: string): string {
  const m = /^(\d{3})([A-F])$/.exec(raw.trim());
  if (!m) throw new LegacyFormatError(`bad legacy seat: ${JSON.stringify(raw)}`);
  return `${Number(m[1])}${m[2]}`;
}

// --- passenger names: {given, surname} -> "SURNAME/GIVEN" ---------------------
function legacyNamePart(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "Élodie" -> "Elodie"
    .toUpperCase()
    .replace(/[^A-Z ]/g, '') // hyphens, apostrophes... are not representable
    .replace(/\s+/g, ' ')
    .trim();
}
export function toLegacyPassengerName(givenName: string, surname: string): string {
  const sur = legacyNamePart(surname).replace(/ /g, '');
  const given = legacyNamePart(givenName);
  if (!sur || !given) throw new LegacyFormatError('passenger name has no representable characters');
  return `${sur}/${given}`.slice(0, 30);
}

// --- seat map rows: "012AXHA-A" -> row 12 with per-letter status -------------
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
export function decodeSeatRow(raw: string): { row: number; seats: Array<{ seat: string; status: SeatStatus }> } {
  const m = /^(\d{3})([AXH-]{6})$/.exec(raw.trim());
  if (!m) throw new LegacyFormatError(`bad seat row from legacy: ${JSON.stringify(raw)}`);
  const row = Number(m[1]);
  const seats: Array<{ seat: string; status: SeatStatus }> = [];
  [...m[2]!].forEach((ch, i) => {
    if (ch === '-') return; // no seat at this position (e.g. business-class rows)
    seats.push({ seat: `${row}${LETTERS[i]}`, status: ch === 'A' ? 'available' : ch === 'H' ? 'held' : 'occupied' });
  });
  return { row, seats };
}

// --- hold status codes (classic PNR status codes) ---------------------------
const HOLD_STATUS: Record<string, HoldStatus> = { HK: 'held', TK: 'ticketed', XX: 'released', EX: 'expired' };
export function fromLegacyHoldStatus(raw: string): HoldStatus {
  const s = HOLD_STATUS[raw.trim()];
  if (!s) throw new LegacyFormatError(`unknown legacy hold status: ${JSON.stringify(raw)}`);
  return s;
}
