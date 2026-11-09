/**
 * Minimal key-value store used by the gateway (cache entries, breaker flag,
 * idempotency records, ticket jobs, modern fares). One DynamoDB table per use,
 * partition key `pk` only. The in-memory implementation is for local runs/tests.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export interface KvItem {
  pk: string;
  [attr: string]: unknown;
}

/** Anything with a partition key (interfaces don't need an index signature). */
export type Keyed = { pk: string };

export type PutCondition =
  | { kind: 'notExists' }
  /** Item absent, or item[attr] < now (an expired lock/lease). Items without attr never match. */
  | { kind: 'notExistsOrExpired'; attr: string; now: number };

export interface KvStore {
  get<T extends Keyed = KvItem>(pk: string): Promise<T | undefined>;
  /** Returns false when the condition fails. */
  put<T extends Keyed>(item: T, condition?: PutCondition): Promise<boolean>;
  delete(pk: string): Promise<void>;
  batchPut<T extends Keyed>(items: T[]): Promise<void>;
  /** Atomically adds 1 to item.n (creating it with the given TTL) and returns the new value. */
  increment(pk: string, ttlEpochSeconds: number): Promise<number>;
}

export class MemoryKvStore implements KvStore {
  private items = new Map<string, Keyed>();
  /** Artificial latency, so local runs resemble a network round trip to DynamoDB. */
  constructor(private latencyMs = 0) {}

  private async delay() {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async get<T extends Keyed = KvItem>(pk: string): Promise<T | undefined> {
    await this.delay();
    const it = this.items.get(pk);
    return it ? (structuredClone(it) as T) : undefined;
  }

  async put<T extends Keyed>(item: T, condition?: PutCondition): Promise<boolean> {
    await this.delay();
    const existing = this.items.get(item.pk);
    if (condition?.kind === 'notExists' && existing) return false;
    if (condition?.kind === 'notExistsOrExpired' && existing) {
      const v = (existing as Record<string, unknown>)[condition.attr];
      if (typeof v !== 'number' || v >= condition.now) return false;
    }
    this.items.set(item.pk, structuredClone(item));
    return true;
  }

  async delete(pk: string) {
    await this.delay();
    this.items.delete(pk);
  }

  async batchPut<T extends Keyed>(items: T[]) {
    for (const it of items) this.items.set(it.pk, structuredClone(it));
  }

  async increment(pk: string, ttlEpochSeconds: number) {
    await this.delay();
    const it = (this.items.get(pk) as { pk: string; n: number } | undefined) ?? { pk, n: 0, ttl: ttlEpochSeconds };
    it.n += 1;
    this.items.set(pk, it);
    return it.n;
  }

  size() {
    return this.items.size;
  }
}

export class DynamoKvStore implements KvStore {
  private doc: DynamoDBDocumentClient;
  constructor(
    private table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get<T extends Keyed = KvItem>(pk: string): Promise<T | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk } }));
    return res.Item as T | undefined;
  }

  async put<T extends Keyed>(item: T, condition?: PutCondition): Promise<boolean> {
    try {
      if (!condition) {
        await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
      } else if (condition.kind === 'notExists') {
        await this.doc.send(new PutCommand({ TableName: this.table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
      } else {
        await this.doc.send(
          new PutCommand({
            TableName: this.table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(pk) OR #a < :now',
            ExpressionAttributeNames: { '#a': condition.attr },
            ExpressionAttributeValues: { ':now': condition.now },
          }),
        );
      }
      return true;
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async delete(pk: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk } }));
  }

  async batchPut<T extends Keyed>(items: T[]) {
    for (let i = 0; i < items.length; i += 25) {
      let pending = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 0; pending.length > 0; attempt++) {
        const res = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending } }));
        pending = (res.UnprocessedItems?.[this.table] ?? []) as typeof pending;
        if (pending.length > 0) await new Promise((r) => setTimeout(r, Math.min(2000, 50 * 2 ** attempt)));
      }
    }
  }

  async increment(pk: string, ttlEpochSeconds: number) {
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk },
        UpdateExpression: 'ADD n :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttlEpochSeconds },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return Number(res.Attributes?.n ?? 1);
  }
}
