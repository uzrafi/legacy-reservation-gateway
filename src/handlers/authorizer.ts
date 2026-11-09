/**
 * Lambda REQUEST authorizer: verifies an RS256 JWT (issuer/audience/expiry) and
 * returns an IAM policy that allows exactly the routes the token's scopes cover.
 *
 * Because API Gateway caches the policy per token (TTL 300 s), the policy must
 * cover *all* routes the token may call, not just the one being requested;
 * otherwise a cached policy from GET /fares would wrongly deny POST /holds.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { importSPKI, jwtVerify, type KeyLike } from 'jose';
import { logger } from '../lib/observability';
import { JWT_AUDIENCE, JWT_ISSUER, ROUTE_SCOPES } from '../lib/scopes';

let key: Promise<KeyLike> | undefined;

async function loadKey(): Promise<KeyLike> {
  let pem = process.env.AUTH_PUBLIC_KEY_PEM;
  if (!pem && process.env.AUTH_PUBLIC_KEY_PARAM) {
    const res = await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.AUTH_PUBLIC_KEY_PARAM }));
    pem = res.Parameter?.Value;
  }
  if (!pem) throw new Error('no public key configured');
  return importSPKI(pem, 'RS256');
}

export function buildPolicy(methodArn: string, principalId: string, scopes: string[]): APIGatewayAuthorizerResult {
  // arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/{method}/{resource...}
  const [arnPrefix, stage] = methodArn.split('/');
  const base = `${arnPrefix}/${stage}`;
  const allowed = ROUTE_SCOPES.filter((r) => scopes.includes(r.scope)).map((r) => `${base}/${r.method}/${r.resource}`);
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: allowed.length
        ? [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: allowed }]
        : [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: `${base}/*/*` }],
    },
    context: { principalId, scopes: scopes.join(' ') },
  };
}

export async function handler(event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
  const auth = event.headers?.Authorization ?? event.headers?.authorization ?? '';
  const token = /^Bearer (.+)$/.exec(auth)?.[1];
  if (!token) throw new Error('Unauthorized'); // API Gateway maps this exact message to 401
  try {
    key ??= loadKey();
    const { payload } = await jwtVerify(token, await key, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithms: ['RS256'] });
    const scopes = String(payload.scope ?? '').split(' ').filter(Boolean);
    return buildPolicy(event.methodArn, String(payload.sub ?? 'unknown'), scopes);
  } catch (err) {
    logger.info('token rejected', { error: (err as Error).message });
    if ((err as Error).message === 'no public key configured') key = undefined;
    throw new Error('Unauthorized');
  }
}
