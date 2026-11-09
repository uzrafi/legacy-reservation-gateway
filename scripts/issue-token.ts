/**
 * Mints a partner JWT (RS256) for the gateway's Lambda authorizer.
 *
 *   npm run token -- --init                                   create a local key pair in .keys/
 *   npm run token -- --sub partner-basic --scopes "fares:read holds:write tickets:write"
 *   npm run token -- --ssm /lrg/dev/auth/private-key --sub partner-premium   (sign with the deployed key)
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ALL_SCOPES, JWT_AUDIENCE, JWT_ISSUER } from '../src/lib/scopes';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export async function signingKeyPem(ssmParam?: string): Promise<string> {
  if (ssmParam) {
    const res = await new SSMClient({}).send(new GetParameterCommand({ Name: ssmParam, WithDecryption: true }));
    return res.Parameter!.Value!;
  }
  return readFileSync('.keys/private.pem', 'utf8');
}

export async function issueToken(opts: { pem: string; sub: string; scopes: string[]; ttl?: string }): Promise<string> {
  const key = await importPKCS8(opts.pem, 'RS256');
  return new SignJWT({ scope: opts.scopes.join(' ') })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(opts.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.ttl ?? '2h')
    .sign(key);
}

async function main() {
  if (process.argv.includes('--init')) {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    mkdirSync('.keys', { recursive: true });
    writeFileSync('.keys/private.pem', await exportPKCS8(privateKey));
    writeFileSync('.keys/public.pem', await exportSPKI(publicKey));
    console.log('wrote .keys/private.pem and .keys/public.pem (git-ignored)');
    console.log('local harness: set LOCAL_AUTH=jwt and AUTH_PUBLIC_KEY_PEM="$(cat .keys/public.pem)"');
    return;
  }
  const scopes = (arg('scopes') ?? ALL_SCOPES.join(' ')).split(' ').filter(Boolean);
  const pem = await signingKeyPem(arg('ssm'));
  console.log(await issueToken({ pem, sub: arg('sub') ?? 'partner-basic', scopes, ttl: arg('ttl') }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
