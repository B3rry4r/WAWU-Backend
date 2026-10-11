import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MoneyModule } from '../money.module';
import { MoneyCheckService, type RunOutcome } from './money-check.service';

/**
 * Makes the nightly check by hand (task MONEY-16): `npm run money:check`,
 * after `npm run build`, with the Hub's own environment. A run that died, or
 * a night nobody made, is made now; a night that has finished is left alone
 * unless `--again` is given, which makes one more run for it.
 *
 *   npm run money:check                      tonight's (Lagos) run
 *   npm run money:check -- --night=2026-10-12
 *   npm run money:check -- --again
 *
 * It starts no web server and no schedule. It prints one line of JSON (the
 * outcome, the run's id, the verdict and the counts) and exits 0 when the
 * run finished or had already finished, 2 otherwise. The report itself is
 * the run's row (`MoneyCheckRun.report`) and the email.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MoneyModule,
  ],
})
export class MoneyCheckCliModule {}

export interface CliArgs {
  night?: string;
  again: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { again: false };
  for (const a of argv) {
    if (a === '--again') args.again = true;
    else if (a.startsWith('--night=')) args.night = a.slice('--night='.length);
    else
      throw new RangeError(
        `Unknown argument ${a}. Use --night=YYYY-MM-DD or --again.`,
      );
  }
  return args;
}

export function summaryOf(outcome: RunOutcome): Record<string, unknown> {
  if (outcome.state === 'finished') {
    const r = outcome.report;
    return {
      state: outcome.state,
      runId: outcome.runId,
      night: r.night,
      verdict: outcome.verdict,
      walletsChecked: r.wallets.checked,
      walletsTotal: r.wallets.total,
      mismatches: r.mismatches.length + r.omitted.mismatches,
      look: r.look.length + r.omitted.look,
    };
  }
  return { ...outcome };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(MoneyCheckCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const outcome = await app
      .get(MoneyCheckService)
      .runNight({ night: args.night, again: args.again, byHand: true });
    process.stdout.write(`${JSON.stringify(summaryOf(outcome))}\n`);
    process.exitCode =
      outcome.state === 'finished' || outcome.state === 'already_done' ? 0 : 2;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `money check failed: ${e instanceof Error ? e.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
