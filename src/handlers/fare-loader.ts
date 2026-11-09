/**
 * S3 ObjectCreated -> load a FAREDUMP CSV into the modern fares table.
 * This is the data path of the strangler-fig fare service.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';
import { getContext } from '../app/context';
import { parseFareCsv } from '../modern/fare-service';
import { countMetric, flushMetrics, logger, tracer } from '../lib/observability';

const s3 = tracer.captureAWSv3Client(new S3Client({}));

export async function handler(event: S3Event) {
  const ctx = getContext();
  let total = 0;
  for (const rec of event.Records) {
    const bucket = rec.s3.bucket.name;
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const fares = parseFareCsv(await obj.Body!.transformToString(), key);
    await ctx.faresStore.batchPut(fares);
    total += fares.length;
    logger.info('fare export loaded', { bucket, key, rows: fares.length });
  }
  countMetric('FaresLoaded', total);
  flushMetrics();
  return { loaded: total };
}
