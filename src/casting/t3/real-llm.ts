/**
 * The real model client for T3, behind the LlmDriver interface.
 *
 * This is the ONLY file of the stage that can construct the production Gemini
 * driver, and it does so lazily: the import of `ai/gemini.client` (which builds
 * the driver from the environment at module load) happens inside the factory,
 * never at import time. Only the apply path of the runner calls the factory,
 * and only after its approval guards pass. Tests and dry-runs never reach it;
 * `__tests__/no-real-client.test.ts` enforces that nothing else imports it or
 * the client module.
 */
import type { LlmDriver } from '../../ai/ai.types';

export async function createRealLlm(): Promise<LlmDriver> {
  const mod = await import('../../ai/gemini.client');
  // gemini.client falls back to a mock driver when no Gemini config is present. A paid run must
  // never go on with it: it would "succeed" with empty answers.
  if (mod.defaultLlm.name === 'mock') {
    throw new Error(
      'the model client is the mock driver: set GEMINI_USE_ENTERPRISE=true and GCP_PROJECT_ID; nothing was started',
    );
  }
  return mod.defaultLlm;
}
