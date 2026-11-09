/**
 * Legacy host credentials: SSM Parameter Store SecureString, read once per
 * container and cached (re-read every 15 min so rotation is picked up).
 * Locally, LEGACY_USER / LEGACY_PASSWORD env vars are used instead.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { tracer } from './observability';

export interface LegacyCredentials {
  user: string;
  password: string;
}

const REFRESH_MS = 15 * 60_000;
let cached: { at: number; value: Promise<LegacyCredentials> } | undefined;
let ssm: SSMClient | undefined;

export function legacyCredentialsProvider(paramName: string | undefined): () => Promise<LegacyCredentials> {
  return () => {
    if (!paramName) {
      return Promise.resolve({ user: process.env.LEGACY_USER ?? 'GATEWAY', password: process.env.LEGACY_PASSWORD ?? 'local-dev-password' });
    }
    if (cached && Date.now() - cached.at < REFRESH_MS) return cached.value;
    ssm ??= tracer.captureAWSv3Client(new SSMClient({}));
    const value = ssm
      .send(new GetParameterCommand({ Name: paramName, WithDecryption: true }))
      .then((r) => JSON.parse(r.Parameter?.Value ?? '{}') as LegacyCredentials);
    value.catch(() => {
      cached = undefined;
    });
    cached = { at: Date.now(), value };
    return value;
  };
}
