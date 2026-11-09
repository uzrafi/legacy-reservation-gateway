/**
 * Dependency container. Built once per Lambda container (module scope), or
 * explicitly by the local harness / tests with in-memory stores.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { LegacyClient } from '../adapter/client';
import { ReadThroughCache } from '../cache/read-through';
import { type Config, loadConfig } from '../lib/config';
import { countMetric, logger, tracer } from '../lib/observability';
import { legacyCredentialsProvider } from '../lib/secrets';
import { ModernFareService } from '../modern/fare-service';
import { CircuitBreaker, KvSharedBreakerState } from '../resilience/circuit-breaker';
import { WindowRateLimiter } from '../resilience/rate-limiter';
import { DynamoKvStore, type KvStore, MemoryKvStore } from '../store/kv';

export interface RevalidationRequest {
  kind: 'fare' | 'seatmap';
  key: string;
  query: Record<string, string>;
}

export interface WorkflowStarter {
  /** Must be idempotent per name (Step Functions Standard dedupes execution names). */
  start(name: string, input: Record<string, unknown>): Promise<void>;
}

export interface AppContext {
  config: Config;
  cacheStore: KvStore;
  stateStore: KvStore;
  faresStore: KvStore;
  breaker: CircuitBreaker;
  legacy: LegacyClient;
  cache: ReadThroughCache;
  modernFares: ModernFareService;
  revalidate: (req: RevalidationRequest) => Promise<void>;
  workflow: WorkflowStarter;
}

export interface ContextOverrides {
  config?: Partial<Config>;
  cacheStore?: KvStore;
  stateStore?: KvStore;
  faresStore?: KvStore;
  revalidate?: (req: RevalidationRequest) => Promise<void>;
  workflow?: WorkflowStarter;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Qualified ARN of the running Lambda (set per invocation) so self-invokes hit the same version. */
let selfArn: string | undefined;
export function setInvokedFunctionArn(arn: string | undefined) {
  selfArn = arn;
}

export function buildContext(overrides: ContextOverrides = {}): AppContext {
  const config = { ...loadConfig(), ...overrides.config };
  const ddb = config.cacheTable || config.stateTable || config.faresTable ? tracer.captureAWSv3Client(new DynamoDBClient({})) : undefined;
  const kv = (table: string | undefined) => (table && ddb ? new DynamoKvStore(table, ddb) : new MemoryKvStore());

  const cacheStore = overrides.cacheStore ?? kv(config.cacheTable);
  const stateStore = overrides.stateStore ?? kv(config.stateTable);
  const faresStore = overrides.faresStore ?? kv(config.faresTable);

  const breaker = new CircuitBreaker({
    name: 'reslink',
    ...config.breaker,
    shared: new KvSharedBreakerState(cacheStore),
    now: overrides.now,
    onStateChange: (from, to) => {
      logger.warn('circuit breaker state change', { from, to });
      countMetric('CircuitBreakerTransitions', 1, { to });
    },
  });

  const legacy = new LegacyClient({
    endpoint: config.legacyEndpoint,
    credentials: legacyCredentialsProvider(config.legacyCredentialsParam),
    breaker,
    limiter: new WindowRateLimiter(cacheStore, { name: 'reslink', perSecond: config.legacyRateLimitPerSec, now: overrides.now }),
    fetchImpl: overrides.fetchImpl,
    policies: {
      default: config.retry.query,
      HoldSeat: config.retry.command,
      GetHoldStatus: config.retry.workflow,
      ReleaseHold: config.retry.workflow,
      IssueTicket: config.retry.workflow,
    },
  });

  let lambda: LambdaClient | undefined;
  const revalidate =
    overrides.revalidate ??
    (async (req: RevalidationRequest) => {
      if (!selfArn) throw new Error('no function ARN to self-invoke');
      lambda ??= tracer.captureAWSv3Client(new LambdaClient({}));
      await lambda.send(
        new InvokeCommand({ FunctionName: selfArn, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ revalidate: req })) }),
      );
    });

  let sfn: SFNClient | undefined;
  const workflow: WorkflowStarter = overrides.workflow ?? {
    async start(name, input) {
      sfn ??= tracer.captureAWSv3Client(new SFNClient({}));
      try {
        await sfn.send(new StartExecutionCommand({ stateMachineArn: config.stateMachineArn, name, input: JSON.stringify(input) }));
      } catch (err) {
        // Same name + same input = already started (idempotent). Anything else is a real error.
        if ((err as Error).name !== 'ExecutionAlreadyExists') throw err;
      }
    },
  };

  return {
    config,
    cacheStore,
    stateStore,
    faresStore,
    breaker,
    legacy,
    cache: new ReadThroughCache(cacheStore, overrides.now),
    modernFares: new ModernFareService(faresStore, config.fareRules),
    revalidate,
    workflow,
  };
}

let current: AppContext | undefined;
export function getContext(): AppContext {
  current ??= buildContext();
  return current;
}
export function setContext(ctx: AppContext | undefined) {
  current = ctx;
}
