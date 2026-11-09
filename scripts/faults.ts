/**
 * Fault injection on the legacy host, from the command line.
 *
 *   npm run faults -- get
 *   npm run faults -- set errorRate=0.2 hangRate=0
 *   npm run faults -- reset
 *   npm run faults -- stats | stats-reset
 *
 * Target: LEGACY_URL (base URL ending in "/"; default the local harness) and LEGACY_ADMIN_TOKEN.
 */
const base = process.env.LEGACY_URL ?? 'http://127.0.0.1:9081/';
const token = process.env.LEGACY_ADMIN_TOKEN ?? 'local-admin-token';

export async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}admin/${path}`, {
    method,
    headers: { 'x-admin-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let out: unknown;
  if (cmd === 'get') out = await admin('GET', 'faults');
  else if (cmd === 'set') out = await admin('POST', 'faults', Object.fromEntries(rest.map((kv) => [kv.split('=')[0], Number(kv.split('=')[1])])));
  else if (cmd === 'reset') out = await admin('DELETE', 'faults');
  else if (cmd === 'stats') out = await admin('GET', 'stats');
  else if (cmd === 'stats-reset') out = await admin('DELETE', 'stats');
  else {
    console.error('usage: faults get | set key=value... | reset | stats | stats-reset');
    process.exit(2);
  }
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
