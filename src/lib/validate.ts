import type { z } from 'zod';
import { ValidationError } from './errors';

/** Parses with zod; failures become a 400 problem listing every issue. */
export function validate<S extends z.ZodType>(schema: S, input: unknown, root = '(body)'): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new ValidationError(r.error.issues.map((i) => ({ path: i.path.map(String).join('.') || root, message: i.message })));
  }
  return r.data;
}
