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
  return mod.defaultLlm;
}
