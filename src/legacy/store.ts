import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { FaultProfile } from './faults';

export type HoldStatus = 'HK' | 'TK' | 'XX' | 'EX'; // held, ticketed, released, expired

export interface HoldRecord {
  holdId: string;
  flight: string; // AC0105
  dateKey: string; // 14NOV26
  seat: string; // 12A
  passenger: string; // RAFI/UZAIR
  status: HoldStatus;
  expiresAt: number; // epoch ms
  ticketNumber?: string;
}

/** Persistence for the simulated legacy host. */
export interface LegacyStore {
  /** Reserve a seat for a hold. Returns false if the seat is already held/ticketed. */
  reserveSeat(hold: HoldRecord, now: number): Promise<boolean>;
  getHold(holdId: string): Promise<HoldRecord | undefined>;
  saveHold(hold: HoldRecord): Promise<void>;
  freeSeat(flight: string, dateKey: string, seat: string): Promise<void>;
  /** Seats currently reserved (held or ticketed, not expired) on a flight/date. */
  reservedSeats(flight: string, dateKey: string, now: number): Promise<Map<string, 'H' | 'X'>>;
  getFaultProfile(): Promise<Partial<FaultProfile> | undefined>;
  setFaultProfile(p: Partial<FaultProfile> | undefined): Promise<void>;
  incrementStats(counters: Record<string, number>): Promise<void>;
  getStats(): Promise<Record<string, number>>;
  resetStats(): Promise<void>;
  /** Count a request in the current 1-second window; returns the count including this one. */
  hitRateWindow(epochSecond: number): Promise<number>;
}

interface SeatEntry {
  holdId: string;
  state: 'H' | 'X';
  expiresAt: number;
}

export class MemoryLegacyStore implements LegacyStore {
  private seats = new Map<string, SeatEntry>();
  private holds = new Map<string, HoldRecord>();
  private faults: Partial<FaultProfile> | undefined;
  private stats: Record<string, number> = {};
  private windows = new Map<number, number>();

  private seatKey(flight: string, dateKey: string, seat: string) {
    return `${flight}|${dateKey}|${seat}`;
  }

  async reserveSeat(hold: HoldRecord, now: number): Promise<boolean> {
    const key = this.seatKey(hold.flight, hold.dateKey, hold.seat);
    const existing = this.seats.get(key);
    if (existing && (existing.state === 'X' || existing.expiresAt > now)) return false;
    this.seats.set(key, { holdId: hold.holdId, state: 'H', expiresAt: hold.expiresAt });
    this.holds.set(hold.holdId, { ...hold });
    return true;
  }

  async getHold(holdId: string) {
    const h = this.holds.get(holdId);
    return h ? { ...h } : undefined;
  }

  async saveHold(hold: HoldRecord) {
    this.holds.set(hold.holdId, { ...hold });
    if (hold.status === 'TK') {
      this.seats.set(this.seatKey(hold.flight, hold.dateKey, hold.seat), {
        holdId: hold.holdId,
        state: 'X',
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  async freeSeat(flight: string, dateKey: string, seat: string) {
    this.seats.delete(this.seatKey(flight, dateKey, seat));
  }

  async reservedSeats(flight: string, dateKey: string, now: number) {
    const out = new Map<string, 'H' | 'X'>();
    const prefix = `${flight}|${dateKey}|`;
    for (const [k, v] of this.seats) {
      if (k.startsWith(prefix) && (v.state === 'X' || v.expiresAt > now)) out.set(k.slice(prefix.length), v.state);
    }
    return out;
  }

  async getFaultProfile() {
    return this.faults;
  }
  async setFaultProfile(p: Partial<FaultProfile> | undefined) {
    this.faults = p;
  }
  async incrementStats(counters: Record<string, number>) {
    for (const [k, v] of Object.entries(counters)) this.stats[k] = (this.stats[k] ?? 0) + v;
  }
  async getStats() {
    return { ...this.stats };
  }
  async resetStats() {
    this.stats = {};
  }
  async hitRateWindow(epochSecond: number) {
    const n = (this.windows.get(epochSecond) ?? 0) + 1;
    this.windows.set(epochSecond, n);
    if (this.windows.size > 120) {
      for (const k of this.windows.keys()) if (k < epochSecond - 60) this.windows.delete(k);
    }
    return n;
  }
}

/**
 * DynamoDB layout (table with pk + sk):
 *   SEATS#AC0105#14NOV26 | 12A        -> seat reservation
 *   HOLD#<id>            | HOLD       -> hold record
 *   CONFIG               | FAULTS     -> fault-injection profile
 *   STATS                | COUNTERS   -> call counters (atomic ADD)
 *   RATE#<epochSecond>   | WINDOW     -> rate-limit window counter
 */
export class DynamoLegacyStore implements LegacyStore {
  private doc: DynamoDBDocumentClient;
  constructor(
    private table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async reserveSeat(hold: HoldRecord, now: number) {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: `SEATS#${hold.flight}#${hold.dateKey}`,
            sk: hold.seat,
            holdId: hold.holdId,
            state: 'H',
            expiresAt: hold.expiresAt,
            ttl: Math.floor(hold.expiresAt / 1000) + 86400,
          },
          ConditionExpression: 'attribute_not_exists(pk) OR (#s = :h AND expiresAt < :now)',
          ExpressionAttributeNames: { '#s': 'state' },
          ExpressionAttributeValues: { ':h': 'H', ':now': now },
        }),
      );
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
    await this.saveHold(hold);
    return true;
  }

  async getHold(holdId: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `HOLD#${holdId}`, sk: 'HOLD' } }));
    if (!res.Item) return undefined;
    const { pk: _pk, sk: _sk, ttl: _ttl, ...rest } = res.Item;
    return rest as HoldRecord;
  }

  async saveHold(hold: HoldRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `HOLD#${hold.holdId}`, sk: 'HOLD', ...hold, ttl: Math.floor(Date.now() / 1000) + 7 * 86400 },
      }),
    );
    if (hold.status === 'TK') {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: `SEATS#${hold.flight}#${hold.dateKey}`,
            sk: hold.seat,
            holdId: hold.holdId,
            state: 'X',
            expiresAt: Number.MAX_SAFE_INTEGER,
            ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
        }),
      );
    }
  }

  async freeSeat(flight: string, dateKey: string, seat: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: `SEATS#${flight}#${dateKey}`, sk: seat } }));
  }

  async reservedSeats(flight: string, dateKey: string, now: number) {
    const out = new Map<string, 'H' | 'X'>();
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': `SEATS#${flight}#${dateKey}` },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of res.Items ?? []) {
        if (it.state === 'X' || (it.expiresAt as number) > now) out.set(it.sk as string, it.state as 'H' | 'X');
      }
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async getFaultProfile() {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: 'CONFIG', sk: 'FAULTS' } }));
    return res.Item?.profile as Partial<FaultProfile> | undefined;
  }

  async setFaultProfile(p: Partial<FaultProfile> | undefined) {
    if (!p) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'CONFIG', sk: 'FAULTS' } }));
      return;
    }
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: 'CONFIG', sk: 'FAULTS', profile: p } }));
  }

  async incrementStats(counters: Record<string, number>) {
    const entries = Object.entries(counters);
    if (entries.length === 0) return;
    const names: Record<string, string> = {};
    const values: Record<string, number> = {};
    const parts = entries.map(([k, v], i) => {
      names[`#n${i}`] = k;
      values[`:v${i}`] = v;
      return `#n${i} :v${i}`;
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: 'STATS', sk: 'COUNTERS' },
        UpdateExpression: `ADD ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async getStats() {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: 'STATS', sk: 'COUNTERS' }, ConsistentRead: true }),
    );
    if (!res.Item) return {};
    const { pk: _pk, sk: _sk, ...counters } = res.Item;
    return counters as Record<string, number>;
  }

  async resetStats() {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'STATS', sk: 'COUNTERS' } }));
  }

  async hitRateWindow(epochSecond: number) {
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `RATE#${epochSecond}`, sk: 'WINDOW' },
        UpdateExpression: 'ADD hits :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': epochSecond + 120 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return Number(res.Attributes?.hits ?? 1);
  }
}
