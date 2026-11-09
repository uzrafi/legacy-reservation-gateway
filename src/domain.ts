/**
 * The gateway's own, clean domain model. These shapes are what the OpenAPI
 * contract exposes; the legacy formats never leak past src/adapter.
 */
import { z } from 'zod';

export const FARE_CLASSES = ['Y', 'M', 'O', 'J'] as const;

const iata = z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter IATA airport code');
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'must be a real calendar date')
  .refine((s) => {
    const y = Number(s.slice(0, 4));
    return y >= 2000 && y <= 2099;
  }, 'year must be between 2000 and 2099');
export const flightNumberSchema = z.string().regex(/^AC\d{1,4}$/, 'must look like AC105');

export const fareQuerySchema = z
  .object({
    origin: iata,
    destination: iata,
    date: isoDate,
    fareClass: z.enum(FARE_CLASSES).default('Y'),
  })
  .refine((q) => q.origin !== q.destination, { message: 'origin and destination must differ', path: ['destination'] });
export type FareQuery = z.infer<typeof fareQuerySchema>;
export type FareClass = (typeof FARE_CLASSES)[number];

export const seatMapQuerySchema = z.object({ flightNumber: flightNumberSchema, date: isoDate });
export type SeatMapQuery = z.infer<typeof seatMapQuerySchema>;

export const holdRequestSchema = z.object({
  flightNumber: flightNumberSchema,
  date: isoDate,
  seat: z.string().regex(/^([1-9]|[12]\d|30)[A-F]$/, 'must look like 12A'),
  passenger: z.object({
    givenName: z.string().min(1).max(40),
    surname: z.string().min(1).max(40),
  }),
});
export type HoldRequest = z.infer<typeof holdRequestSchema>;

export const ticketRequestSchema = z.object({
  holdId: z.string().regex(/^H[0-9A-Z]{7}$/, 'must be a hold id like HA258845'),
  paymentRef: z.string().regex(/^[A-Za-z0-9-]{4,24}$/, 'must be 4-24 letters, digits or dashes'),
});
export type TicketRequest = z.infer<typeof ticketRequestSchema>;

export interface FareQuote {
  quoteId: string;
  origin: string;
  destination: string;
  flightNumber: string;
  date: string;
  fareClass: FareClass;
  priceCents: number;
  currency: string;
}

export type SeatStatus = 'available' | 'occupied' | 'held';
export interface SeatMap {
  flightNumber: string;
  date: string;
  aircraft: string;
  availableSeats: number;
  rows: Array<{ row: number; seats: Array<{ seat: string; status: SeatStatus }> }>;
}

export type HoldStatus = 'held' | 'ticketed' | 'released' | 'expired';
export interface Hold {
  holdId: string;
  status: HoldStatus;
  expiresAt: string;
  flightNumber?: string;
  date?: string;
  seat?: string;
  ticketNumber?: string;
}

export interface IssuedTicket {
  ticketNumber: string;
  holdId: string;
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'TICKETED' | 'FAILED';
export interface TicketJob {
  jobId: string;
  status: JobStatus;
  holdId: string;
  ticketNumber?: string;
  failureReason?: string;
  compensated?: boolean;
  createdAt: string;
  updatedAt: string;
}
