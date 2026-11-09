import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { exportSPKI, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { isAllowed, JWT_AUDIENCE, JWT_ISSUER } from '../../src/lib/scopes';

const ARN = 'arn:aws:execute-api:ca-central-1:123456789012:abc123/dev/GET/fares';

let handler: (e: APIGatewayRequestAuthorizerEvent) => Promise<import('aws-lambda').APIGatewayAuthorizerResult>;
let privateKey: KeyLike;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  process.env.AUTH_PUBLIC_KEY_PEM = await exportSPKI(kp.publicKey);
  ({ handler } = await import('../../src/handlers/authorizer'));
});

const token = (scope: string, opts: { iss?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('partner-basic')
    .setIssuer(opts.iss ?? JWT_ISSUER)
    .setAudience(opts.aud ?? JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);

const event = (auth: string) => ({ type: 'REQUEST', methodArn: ARN, headers: { Authorization: auth } }) as unknown as APIGatewayRequestAuthorizerEvent;

describe('JWT authorizer', () => {
  test('allows every route the scopes cover (policy is cached per token)', async () => {
    const res = await handler(event(`Bearer ${await token('fares:read holds:write')}`));
    expect(res.principalId).toBe('partner-basic');
    const stmt = res.policyDocument.Statement[0] as { Effect: string; Resource: string[] };
    expect(stmt.Effect).toBe('Allow');
    expect(stmt.Resource).toEqual([
      'arn:aws:execute-api:ca-central-1:123456789012:abc123/dev/GET/fares',
      'arn:aws:execute-api:ca-central-1:123456789012:abc123/dev/GET/seatmaps/*',
      'arn:aws:execute-api:ca-central-1:123456789012:abc123/dev/POST/holds',
    ]);
    expect(res.context).toMatchObject({ scopes: 'fares:read holds:write' });
  });

  test('a valid token with no useful scope gets an explicit Deny (403)', async () => {
    const res = await handler(event(`Bearer ${await token('profile')}`));
    expect((res.policyDocument.Statement[0] as { Effect: string }).Effect).toBe('Deny');
  });

  test.each([
    ['missing header', ''],
    ['not bearer', 'Basic abc'],
    ['garbage', 'Bearer not.a.jwt'],
  ])('%s -> Unauthorized (401)', async (_name, auth) => {
    await expect(handler(event(auth))).rejects.toThrow('Unauthorized');
  });

  test('wrong issuer, wrong audience and expired tokens are rejected', async () => {
    await expect(handler(event(`Bearer ${await token('fares:read', { iss: 'https://evil' })}`))).rejects.toThrow('Unauthorized');
    await expect(handler(event(`Bearer ${await token('fares:read', { aud: 'other' })}`))).rejects.toThrow('Unauthorized');
    await expect(handler(event(`Bearer ${await token('fares:read', { exp: '-1m' })}`))).rejects.toThrow('Unauthorized');
  });

  test('isAllowed matches path parameters', () => {
    expect(isAllowed('GET', '/seatmaps/AC105', ['fares:read'])).toBe(true);
    expect(isAllowed('GET', '/seatmaps/', ['fares:read'])).toBe(false);
    expect(isAllowed('POST', '/tickets', ['fares:read'])).toBe(false);
    expect(isAllowed('GET', '/tickets/abc', ['tickets:write'])).toBe(true);
  });
});
