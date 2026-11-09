/**
 * HTTP server for the simulated legacy host: SOAP endpoint (node-soap) at /reslink,
 * WSDL at /reslink?wsdl, plus a small admin API used by experiments:
 *   GET/POST/DELETE /admin/faults   fault-injection override
 *   GET/DELETE      /admin/stats    call counters
 *   GET             /health
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as soap from 'soap';
import { envFaultProfile, parseFaultOverride } from './faults';
import { createLegacyService } from './service';
import type { LegacyStore } from './store';

export interface LegacyServerOptions {
  store: LegacyStore;
  credentials: { user: string; password: string };
  adminToken: string;
  port?: number;
  host?: string;
}

function loadWsdl(): string {
  const candidates = [path.join(__dirname, 'reslink.wsdl'), path.join(process.cwd(), 'src/legacy/reslink.wsdl')];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error('reslink.wsdl not found');
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startLegacyServer(opts: LegacyServerOptions): Promise<{ server: http.Server; url: string }> {
  const { store } = opts;
  const service = createLegacyService({ store, credentials: opts.credentials });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (!url.pathname.startsWith('/admin/')) {
      res.writeHead(404);
      return res.end();
    }
    if (req.headers['x-admin-token'] !== opts.adminToken) return sendJson(res, 401, { error: 'bad admin token' });
    try {
      if (url.pathname === '/admin/faults') {
        if (req.method === 'GET') {
          const override = await store.getFaultProfile();
          return sendJson(res, 200, { defaults: envFaultProfile(), override: override ?? null });
        }
        if (req.method === 'POST') {
          const override = parseFaultOverride(JSON.parse((await readBody(req)) || '{}'));
          await store.setFaultProfile(override);
          return sendJson(res, 200, { override });
        }
        if (req.method === 'DELETE') {
          await store.setFaultProfile(undefined);
          return sendJson(res, 200, { override: null });
        }
      }
      if (url.pathname === '/admin/stats') {
        if (req.method === 'GET') return sendJson(res, 200, await store.getStats());
        if (req.method === 'DELETE') {
          await store.resetStats();
          return sendJson(res, 200, {});
        }
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  });
  server.keepAliveTimeout = 65_000;

  soap.listen(server, '/reslink', { ResLinkService: { ResLinkPort: service } }, loadWsdl());

  await new Promise<void>((resolve) => server.listen(opts.port ?? 9081, opts.host ?? '0.0.0.0', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}
