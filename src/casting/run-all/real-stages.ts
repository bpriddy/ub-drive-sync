/**
 * The production wiring of `casting-run`: the real stage entry points, each behind a dynamic
 * import that runs only when that stage runs. This is the only file of the folder that reaches
 * Prisma, Drive or (through the pilot driver's own lazy factory) the model client.
 *
 * Stages run in-process. T1, T2 and fusion export their `main(argv)`; the pilot driver and the
 * ledger loader are called through their `run*Cli` functions, so their guard errors keep the
 * stage's own exit code (2) and message. The model client is still created only by the stage's
 * apply path, after every guard (ours first, then the stage's own).
 */
import type { StageFns } from './run';

export function realStages(): StageFns {
  return {
    t1: async (argv) => (await import('../t1/main')).main(argv),
    t2: async (argv) => (await import('../t2/main')).main(argv),
    fusion: async (argv) => (await import('../fusion/main')).main(argv),
    t3: async (argv, hooks) => {
      const { realIo, runPilotCli } = await import('../t3/pilot-main');
      return runPilotCli(argv, {
        ...realIo(),
        beforeApply: hooks.beforeApply,
        ...(hooks.onProposal ? { onProposal: hooks.onProposal } : {}),
      });
    },
    load: async (argv) => {
      const { realLoadIo, runLoadCli } = await import('../t3/load-main');
      return runLoadCli(argv, realLoadIo());
    },
  };
}
