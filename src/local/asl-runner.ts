/**
 * A tiny interpreter for the subset of Amazon States Language used by
 * infra/sfn/ticketing.asl.json (Task, Choice, Pass, Fail, Succeed; Parameters,
 * ResultPath, TimeoutSeconds, Retry with backoff/jitter, Catch).
 *
 * It exists so the *same* state machine definition that Terraform deploys can be
 * exercised locally and in unit tests, including the compensation path.
 * It is not a general ASL implementation.
 */
type Json = unknown;
type Obj = Record<string, unknown>;

interface Retrier {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
  MaxDelaySeconds?: number;
  JitterStrategy?: 'FULL' | 'NONE';
}
interface Catcher {
  ErrorEquals: string[];
  ResultPath?: string | null;
  Next: string;
}
interface State {
  Type: 'Task' | 'Choice' | 'Pass' | 'Fail' | 'Succeed';
  Resource?: string;
  Parameters?: Obj;
  Result?: Json;
  ResultPath?: string | null;
  TimeoutSeconds?: number;
  Retry?: Retrier[];
  Catch?: Catcher[];
  Choices?: Array<{ Variable: string; BooleanEquals?: boolean; StringEquals?: string; Next: string }>;
  Default?: string;
  Next?: string;
  End?: boolean;
  Error?: string;
  Cause?: string;
}
export interface StateMachine {
  StartAt: string;
  States: Record<string, State>;
}

export interface RunOptions {
  invoke: (resource: string, payload: Json) => Promise<Json>;
  /** Multiply all waits (0 in unit tests). */
  timeScale?: number;
  random?: () => number;
  onTransition?: (state: string) => void;
}

export interface RunResult {
  status: 'SUCCEEDED' | 'FAILED';
  output?: Json;
  error?: string;
  cause?: string;
  transitions: string[];
}

function getPath(doc: Json, path: string): Json {
  if (path === '$') return doc;
  if (!path.startsWith('$.')) throw new Error(`unsupported path ${path}`);
  return path
    .slice(2)
    .split('.')
    .reduce<Json>((v, k) => (v && typeof v === 'object' ? (v as Obj)[k] : undefined), doc);
}

function setPath(doc: Json, path: string | null | undefined, value: Json): Json {
  if (path === null) return doc;
  if (path === undefined || path === '$') return value;
  const keys = path.slice(2).split('.');
  const root: Obj = structuredClone((doc ?? {}) as Obj);
  let cur = root;
  keys.slice(0, -1).forEach((k) => {
    cur[k] = typeof cur[k] === 'object' && cur[k] !== null ? { ...(cur[k] as Obj) } : {};
    cur = cur[k] as Obj;
  });
  cur[keys[keys.length - 1]!] = value;
  return root;
}

function applyParameters(params: Obj | undefined, input: Json): Json {
  if (!params) return input;
  const out: Obj = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.endsWith('.$')) out[k.slice(0, -2)] = getPath(input, v as string);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = applyParameters(v as Obj, input);
    else out[k] = v;
  }
  return out;
}

const matches = (errorEquals: string[], name: string) =>
  errorEquals.includes(name) || errorEquals.includes('States.ALL') || (errorEquals.includes('States.TaskFailed') && name !== 'States.Timeout');

class StatesError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export async function runStateMachine(def: StateMachine, input: Json, opts: RunOptions): Promise<RunResult> {
  const scale = opts.timeScale ?? 1;
  const random = opts.random ?? Math.random;
  const sleep = (s: number) => (s * scale > 0 ? new Promise((r) => setTimeout(r, s * 1000 * scale)) : Promise.resolve());
  const transitions: string[] = [];
  let name = def.StartAt;
  let doc = input;

  for (let guard = 0; guard < 1000; guard++) {
    const state = def.States[name];
    if (!state) throw new Error(`unknown state ${name}`);
    transitions.push(name);
    opts.onTransition?.(name);

    switch (state.Type) {
      case 'Succeed':
        return { status: 'SUCCEEDED', output: doc, transitions };
      case 'Fail':
        return { status: 'FAILED', error: state.Error, cause: state.Cause, transitions };
      case 'Pass':
        doc = setPath(doc, state.ResultPath, state.Result ?? doc);
        break;
      case 'Choice': {
        const hit = state.Choices?.find((c) => {
          const v = getPath(doc, c.Variable);
          if (c.BooleanEquals !== undefined) return v === c.BooleanEquals;
          if (c.StringEquals !== undefined) return v === c.StringEquals;
          return false;
        });
        name = hit?.Next ?? state.Default!;
        continue;
      }
      case 'Task': {
        const payload = applyParameters(state.Parameters, doc);
        const attemptsByRetrier = new Map<Retrier, number>();
        let result: Json;
        let caught: { err: Error; catcher: Catcher } | undefined;
        for (;;) {
          try {
            const call = opts.invoke(state.Resource!, payload);
            result = state.TimeoutSeconds
              ? await Promise.race([
                  call,
                  new Promise((_, rej) =>
                    setTimeout(() => rej(new StatesError('States.Timeout', 'task timed out')), state.TimeoutSeconds! * 1000 * Math.max(scale, 0.001)),
                  ),
                ])
              : await call;
            break;
          } catch (e) {
            const err = e as Error;
            const retrier = state.Retry?.find((r) => matches(r.ErrorEquals, err.name));
            const used = retrier ? (attemptsByRetrier.get(retrier) ?? 0) : 0;
            if (retrier && used < (retrier.MaxAttempts ?? 3)) {
              attemptsByRetrier.set(retrier, used + 1);
              let delay = (retrier.IntervalSeconds ?? 1) * (retrier.BackoffRate ?? 2) ** used;
              if (retrier.MaxDelaySeconds) delay = Math.min(delay, retrier.MaxDelaySeconds);
              if (retrier.JitterStrategy === 'FULL') delay *= random();
              await sleep(delay);
              continue;
            }
            const catcher = state.Catch?.find((c) => matches(c.ErrorEquals, err.name));
            if (!catcher) return { status: 'FAILED', error: err.name, cause: err.message, transitions };
            caught = { err, catcher };
            break;
          }
        }
        if (caught) {
          doc = setPath(doc, caught.catcher.ResultPath, { Error: caught.err.name, Cause: JSON.stringify({ errorMessage: caught.err.message }) });
          name = caught.catcher.Next;
          continue;
        }
        doc = setPath(doc, state.ResultPath, result);
        break;
      }
    }
    if (state.End) return { status: 'SUCCEEDED', output: doc, transitions };
    name = state.Next!;
  }
  throw new Error('state machine did not terminate');
}
