import { PrismaService } from '../../../../common/prisma/prisma.service';
import { FeeScheduleService } from '../fee-schedule.service';
import { ProviderRateService } from '../provider-rate.service';

/** Anything with Nest's `get` (a testing module or an application). */
export interface Getter {
  get(token: unknown): unknown;
}

/** WAWU's fee F and Nuvion's charge P for one kind, flat, in kobo. */
export interface FlatFee {
  feeKobo: number;
  providerKobo: number;
}

type SendKind = 'ngn_bank_withdrawal' | 'wallet_to_wallet';

/**
 * A contract spec's own fee rows (FEE-01, R-139): WAWU's fee F and Nuvion's
 * charge P, both flat, for the kinds a Nuvion send uses, and optionally
 * Nuvion's charge on money arriving by bank transfer. Written through the
 * same append-only tables an admin uses, from the spec, never from env. The
 * rows start a second ago so they are the ones in force, and the running
 * app's caches are read again. Take them out with `removeSpecFees`.
 */
export async function seedFees(
  ref: Getter,
  fees: Partial<Record<SendKind, FlatFee>>,
  inflowKobo?: number,
): Promise<void> {
  const prisma = ref.get(PrismaService) as PrismaService;
  const startsAt = new Date(Date.now() - 1000);
  const rate = (kind: string, fixed: number) =>
    prisma.providerRate.create({
      data: {
        provider: 'nuvion',
        kind,
        currency: 'NGN',
        percentPpm: 0,
        minMinor: 0n,
        maxMinor: null,
        fixedMinor: BigInt(fixed),
        startsAt,
        changedBy: 'spec',
      },
    });
  for (const [kind, f] of Object.entries(fees)) {
    await prisma.feeSchedule.create({
      data: {
        kind,
        currency: 'NGN',
        percentPpm: 0,
        minMinor: BigInt(f.feeKobo),
        maxMinor: BigInt(f.feeKobo),
        startsAt,
        changedBy: 'spec',
      },
    });
    await rate(kind, f.providerKobo);
  }
  if (inflowKobo !== undefined) await rate('ngn_add_money', inflowKobo);
  await (ref.get(FeeScheduleService) as FeeScheduleService).refresh();
  await (ref.get(ProviderRateService) as ProviderRateService).refresh();
}

/** The same flat fee for both kinds a Nuvion send uses. */
export function seedFlatFees(
  ref: Getter,
  f: FlatFee,
  inflowKobo?: number,
): Promise<void> {
  return seedFees(
    ref,
    { ngn_bank_withdrawal: f, wallet_to_wallet: f },
    inflowKobo,
  );
}

/**
 * Takes a spec's own rows out again, so the next spec on the same database
 * reads the migration's seed rows and not this one's. The tables are
 * append-only for the app; a test database's owner switches the triggers off
 * for this one transaction.
 */
export async function removeSpecFees(ref: Getter): Promise<void> {
  const prisma = ref.get(PrismaService) as PrismaService;
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL session_replication_role = replica`,
    prisma.$executeRaw`DELETE FROM "FeeSchedule" WHERE "changedBy" = 'spec'`,
    prisma.$executeRaw`DELETE FROM "ProviderRate" WHERE "changedBy" = 'spec'`,
  ]);
}
