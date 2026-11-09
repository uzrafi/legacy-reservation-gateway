/** Which OAuth-style scope each route needs. Shared by the Lambda authorizer and the local harness. */
export const ROUTE_SCOPES: Array<{ method: string; resource: string; scope: string }> = [
  { method: 'GET', resource: 'fares', scope: 'fares:read' },
  { method: 'GET', resource: 'seatmaps/*', scope: 'fares:read' },
  { method: 'POST', resource: 'holds', scope: 'holds:write' },
  { method: 'POST', resource: 'tickets', scope: 'tickets:write' },
  { method: 'GET', resource: 'tickets/*', scope: 'tickets:write' },
];

export const ALL_SCOPES = [...new Set(ROUTE_SCOPES.map((r) => r.scope))];

export const JWT_ISSUER = 'https://auth.reservation-gateway.local';
export const JWT_AUDIENCE = 'reservation-gateway';

/** Does this method + path (e.g. GET /seatmaps/AC105) need a scope the caller has? */
export function isAllowed(method: string, path: string, scopes: string[]): boolean {
  const p = path.replace(/^\//, '');
  return ROUTE_SCOPES.some((r) => {
    if (r.method !== method || !scopes.includes(r.scope)) return false;
    if (r.resource.endsWith('/*')) return p.startsWith(r.resource.slice(0, -1)) && p.length > r.resource.length - 1;
    return p === r.resource;
  });
}
