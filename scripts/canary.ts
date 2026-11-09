/**
 * Strangler-fig traffic shifting with Lambda weighted aliases.
 *
 *   npm run canary -- prepare --function lrg-dev-fares --mode shadow --rules naive
 *       Publishes a new version whose FARE_MODE/MODERN_FARE_RULES differ, then restores
 *       $LATEST so Terraform sees no drift. Prints the version number.
 *
 *   npm run canary -- shift --function lrg-dev-fares --to 7 --steps 10,50,100 --bake 120 \
 *       --alarms lrg-dev-api-5xx-over-1pct,lrg-dev-fare-shadow-mismatch-over-0.1pct
 *       Moves the "live" alias step by step. After each bake period, if any alarm is in
 *       ALARM the alias is rolled back to the stable version and the script exits 1.
 *
 *   npm run canary -- status --function lrg-dev-fares
 *   npm run canary -- rollback --function lrg-dev-fares
 */
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  PublishVersionCommand,
  UpdateAliasCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
const cw = new CloudWatchClient({});
const ALIAS = 'live';

export async function prepareVersion(fn: string, env: Record<string, string>, description: string): Promise<string> {
  const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
  const original = current.Environment?.Variables ?? {};
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: fn, Environment: { Variables: { ...original, ...env } } }));
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: fn });
  const published = await lambda.send(new PublishVersionCommand({ FunctionName: fn, Description: description }));
  // Put $LATEST back the way Terraform left it.
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: fn, Environment: { Variables: original } }));
  await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: fn });
  return published.Version!;
}

export async function aliasStatus(fn: string) {
  const a = await lambda.send(new GetAliasCommand({ FunctionName: fn, Name: ALIAS }));
  return { stable: a.FunctionVersion!, weights: a.RoutingConfig?.AdditionalVersionWeights ?? {} };
}

async function setWeight(fn: string, stable: string, canary: string, pct: number) {
  if (pct >= 100) {
    await lambda.send(new UpdateAliasCommand({ FunctionName: fn, Name: ALIAS, FunctionVersion: canary, RoutingConfig: { AdditionalVersionWeights: {} } }));
  } else {
    await lambda.send(
      new UpdateAliasCommand({
        FunctionName: fn,
        Name: ALIAS,
        FunctionVersion: stable,
        RoutingConfig: { AdditionalVersionWeights: pct > 0 ? { [canary]: pct / 100 } : {} },
      }),
    );
  }
}

async function alarmsFiring(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: names }));
  return [...(res.MetricAlarms ?? []), ...(res.CompositeAlarms ?? [])].filter((a) => a.StateValue === 'ALARM').map((a) => a.AlarmName!);
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const log = (msg: string) => console.log(`${new Date().toISOString()}  ${msg}`);

export async function shiftTraffic(fn: string, canary: string, steps: number[], bakeSeconds: number, alarms: string[]): Promise<boolean> {
  const { stable } = await aliasStatus(fn);
  if (stable === canary) throw new Error(`alias already points at version ${canary}`);
  log(`canary: ${fn}:${ALIAS} stable v${stable} -> v${canary}, steps ${steps.join(' -> ')}%, bake ${bakeSeconds}s`);
  for (const pct of steps) {
    await setWeight(fn, stable, canary, pct);
    log(`  ${pct}% of traffic on v${canary}`);
    await sleep(bakeSeconds);
    const firing = await alarmsFiring(alarms);
    if (firing.length) {
      await setWeight(fn, stable, canary, 0);
      log(`  ROLLBACK to v${stable}: alarm(s) firing: ${firing.join(', ')}`);
      return false;
    }
  }
  log(`  promoted v${canary}`);
  return true;
}

// ---------------------------------------------------------------- CLI
function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

async function main() {
  const cmd = process.argv[2];
  const fn = arg('function', process.env.FARES_FUNCTION);
  if (cmd === 'prepare') {
    const mode = arg('mode');
    const rules = arg('rules', 'full');
    const v = await prepareVersion(fn, { FARE_MODE: mode, MODERN_FARE_RULES: rules }, `FARE_MODE=${mode} rules=${rules}`);
    console.log(v);
  } else if (cmd === 'shift') {
    const ok = await shiftTraffic(
      fn,
      arg('to'),
      arg('steps', '10,50,100').split(',').map(Number),
      Number(arg('bake', '120')),
      arg('alarms', '').split(',').filter(Boolean),
    );
    process.exit(ok ? 0 : 1);
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await aliasStatus(fn), null, 2));
  } else if (cmd === 'rollback') {
    const { stable } = await aliasStatus(fn);
    await setWeight(fn, stable, stable, 0);
    log(`all traffic on v${stable}`);
  } else {
    console.error('usage: canary prepare|shift|status|rollback --function <name> ...');
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
