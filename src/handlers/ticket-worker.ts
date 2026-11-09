/** Step Functions task handler: { step, input } -> step result. */
import { getContext } from '../app/context';
import { runStep, type StepName, type WorkflowInput } from '../app/ticket-worker';
import { flushMetrics } from '../lib/observability';

export async function handler(event: { step: StepName; input: WorkflowInput }) {
  try {
    return await runStep(getContext(), event.step, event.input);
  } finally {
    flushMetrics();
  }
}
