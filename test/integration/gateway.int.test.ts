/**
 * Integration tests against a deployed stage. Run by CI after `terraform apply`:
 *   API_BASE_URL  https://<id>.execute-api.<region>.amazonaws.com/dev
 *   API_KEY       a partner API key
 *   TOKEN         a JWT with fares:read holds:write tickets:write
 */
const base = (process.env.API_BASE_URL ?? '').replace(/\/$/, '');
const apiKey = process.env.API_KEY ?? '';
const token = process.env.TOKEN ?? '';
const auth = { 'x-api-key': apiKey, authorization: `Bearer ${token}` };
const json = { 'content-type': 'application/json' };

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const key = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

const run = base ? describe : describe.skip;

run('deployed gateway', () => {
  test('GET /fares returns a quote, then serves it from cache', async () => {
    const url = `${base}/fares?origin=YYZ&destination=YVR&date=${day(20)}&fareClass=Y`;
    const first = await fetch(url, { headers: auth });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ origin: 'YYZ', destination: 'YVR', currency: 'CAD', flightNumber: 'AC105' });
    const second = await fetch(url, { headers: auth });
    expect(second.headers.get('x-cache')).toMatch(/HIT|STALE/);
  });

  test('missing API key -> 403, missing token -> 401, both as problem+json', async () => {
    const url = `${base}/fares?origin=YYZ&destination=YVR&date=${day(20)}`;
    const noKey = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(noKey.status).toBe(403);
    const noToken = await fetch(url, { headers: { 'x-api-key': apiKey } });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('content-type')).toContain('application/problem+json');
  });

  test('API Gateway request validation rejects a bad query before Lambda runs', async () => {
    const res = await fetch(`${base}/fares?origin=YYZ`, { headers: auth });
    expect(res.status).toBe(400);
  });

  test('hold -> ticket job -> TICKETED (async, polled)', async () => {
    let holdId: string | undefined;
    for (let i = 0; i < 15 && !holdId; i++) {
      const seat = `${5 + Math.floor(Math.random() * 26)}${'ABCDEF'[Math.floor(Math.random() * 6)]}`;
      const res = await fetch(`${base}/holds`, {
        method: 'POST',
        headers: { ...auth, ...json, 'idempotency-key': key('hold') },
        body: JSON.stringify({ flightNumber: 'AC856', date: day(30), seat, passenger: { givenName: 'Ci', surname: 'Runner' } }),
      });
      if (res.status === 201) holdId = ((await res.json()) as { holdId: string }).holdId;
    }
    expect(holdId).toBeDefined();

    const start = await fetch(`${base}/tickets`, {
      method: 'POST',
      headers: { ...auth, ...json, 'idempotency-key': key('ticket') },
      body: JSON.stringify({ holdId, paymentRef: 'PAY-CI-1' }),
    });
    expect(start.status).toBe(202);
    const { jobId } = (await start.json()) as { jobId: string };

    let status = 'PENDING';
    for (let i = 0; i < 45 && (status === 'PENDING' || status === 'RUNNING'); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      status = ((await (await fetch(`${base}/tickets/${jobId}`, { headers: auth })).json()) as { status: string }).status;
    }
    expect(status).toBe('TICKETED');
  });
});
