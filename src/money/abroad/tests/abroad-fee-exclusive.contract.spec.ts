import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  AbroadProvider,
  AbroadTransfer,
} from '../../../wallet-provider/abroad-provider';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import type { OpenWallet } from '../../gate/wallet-gate';
import type {
  IdempotencyScope,
  IdempotencyService,
} from '../../payments/idempotency';
import { AbroadAdminService } from '../abroad-admin.service';
import { AbroadSendService } from '../abroad-send.service';
import { AbroadService } from '../abroad.service';
import type { AbroadSettings } from '../abroad-settings';

/**
 * SWEEP-MONEY-6, on NUV-11's round 2 lows, on a real database and a provider double of our own (the abroad contract spec holds the
 * rest of the send's decisions):
 * - R2-1: a send that failed or was reversed never goes back to completed or pending on the provider's word; one row puts it in
 *   front of finance and the fee given back stays given back.
 * - R2-2: finance's "paid back outside" and the sweep's give-back cannot both pay the person.
 */

jest.setTimeout(60_000);

const prisma = new PrismaService();
const U = `u-${randomUUID()}`;
const wallet: OpenWallet = {
  wawuUserId: U,
  customerId: `E${U.slice(0, 20)}`.toUpperCase(),
  walletId: `E${U.slice(0, 20)}`.toUpperCase() + ':A' + U.slice(0, 20),
  accountNumber: `00${Math.floor(Math.random() * 1e8)}`,
};

function transfer(over: Partial<AbroadTransfer> = {}): AbroadTransfer {
  return {
    id: `T${randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()}`,
    state: 'pending',
    providerStatus: 'new',
    providerReason: null,
    feeMinor: 0,
    currency: 'NGN',
    amountMinor: 98523,
    reference: null,
    createdAt: null,
    ...over,
  };
}

const settings = {
  enabled: true,
  wawuFeeKobo: 2_500,
  providerFeeMinor: () => null,
  maxPerSend: () => null,
  maxPerDay: () => null,
  countriesOff: () => new Set<string>(),
};

const abroadSide = {
  banks: () => Promise.resolve([]),
  sources: () =>
    Promise.resolve([
      {
        currency: 'USD',
        accountRef: 'ACC-USD',
        displayName: null,
        availableMinor: 100_000,
      },
    ]),
  saveRecipient: () =>
    Promise.resolve({
      counterpartyId: 'CP1',
      paymentDetailId: 'PD1',
      bankName: 'Test Bank',
    }),
  quote: (i: { amountMinor: number }) =>
    Promise.resolve({
      quoteRef: 'Q1',
      amountFromMinor: i.amountMinor,
      amountToMinor: Math.floor(i.amountMinor / 2),
      rate: '0.5',
      expiresAt: new Date(Date.now() + 180_000),
      validForSeconds: 180,
    }),
  send: () => Promise.resolve(transfer()),
  read: () => Promise.resolve(transfer()),
  findByReference: () => Promise.resolve({ state: 'absent' as const }),
} as unknown as AbroadProvider;

type LegInput = {
  fromAccountNumber: string;
  toAccountNumber: string;
  amountKobo: bigint;
  reference: string;
};
/** Every leg the provider was asked to make, in order (a refused ask is here too). */
const legCalls: LegInput[] = [];
const records = new Map<string, { outcome: 'completed'; input: LegInput }>();
/** References the provider refuses (the ask never lands). */
const refuse = new Set<string>();
/** Run at the named moment of the double, so a test can act while the other side is half way. */
const hooks: {
  platform?: () => Promise<void>;
  beforeLeg?: (reference: string) => Promise<void>;
  onFind?: (reference: string) => Promise<void>;
} = {};

const provider = {
  name: 'nuvion',
  label: 'Nuvion',
  abroad: abroadSide,
  getPlatformAccount: async () => {
    await hooks.platform?.();
    return { accountNumber: 'PLATFORM' };
  },
  findTransactionByReference: async (reference: string) => {
    await hooks.onFind?.(reference);
    const rec = records.get(reference);
    return rec
      ? {
          state: 'found' as const,
          transaction: {
            id: `T-${reference}`,
            outcome: rec.outcome,
            amountKobo: rec.input.amountKobo,
            feeKobo: 0n,
            createdAt: new Date().toISOString(),
          },
        }
      : { state: 'absent' as const };
  },
  walletToWallet: async (i: LegInput) => {
    await hooks.beforeLeg?.(i.reference);
    legCalls.push(i);
    if (refuse.has(i.reference)) throw new Error('refused');
    records.set(i.reference, { outcome: 'completed', input: i });
    return {
      amountKobo: i.amountKobo,
      totalKobo: i.amountKobo,
      feeKobo: 0n,
      pending: false,
    };
  },
} as unknown as WalletProvider;

const keys = {
  attach: () => Promise.resolve(),
  finish: () => Promise.resolve(),
  release: () => Promise.resolve(),
} as unknown as IdempotencyService;

const abroad = new AbroadService(
  prisma,
  provider,
  settings as unknown as AbroadSettings,
);
const sends = new AbroadSendService(prisma, provider, abroad, keys);
const admin = new AbroadAdminService(prisma, provider, abroad, sends);
const actor = { id: 'admin-1', email: 'fin@wawu.africa', role: 'finance' };
const scope = (): IdempotencyScope => ({
  wawuUserId: U,
  method: 'POST',
  route: 'POST money/abroad/sends',
  key: randomUUID(),
  fingerprint: 'f',
});

const rowOf = (id: string) =>
  prisma.abroadSend.findUniqueOrThrow({ where: { id } });
const auditOf = (id: string, action?: string) =>
  prisma.abroadAdminAudit.findMany({
    where: { sendId: id, ...(action ? { action } : {}) },
    orderBy: { at: 'asc' },
  });
const backCalls = (reference: string) =>
  legCalls.filter((c) => c.reference.startsWith(`${reference}-fee-back`));

/** A send the provider accepted, with WAWU's fee taken from the wallet. */
async function sendWithFee() {
  const r = (
    await abroad.saveRecipient(wallet, {
      country: 'GH',
      method: 'bank',
      holderName: 'Ama Mensah',
      fields: { bank: '030100', account_number: '0123 4567 89' },
    })
  ).view;
  const q = await abroad.quote(wallet, {
    recipientId: r.id,
    fromCurrency: 'USD',
    amountMinor: 10_000,
  });
  const view = await sends.send(wallet, scope(), { quoteId: q.id });
  const row = await rowOf(view.id);
  expect(row.wawuFeeTaken).toBe(true);
  return { id: view.id, row, transferId: row.providerTransferId! };
}

beforeAll(async () => {
  await prisma.$connect();
  await prisma.fintavaWallet.create({
    data: {
      wawuUserId: wallet.wawuUserId,
      customerId: wallet.customerId,
      walletId: wallet.walletId,
      accountNumber: wallet.accountNumber,
      provider: 'nuvion',
    },
  });
});

afterAll(async () => {
  await prisma.abroadAdminAudit.deleteMany({ where: { subjectWawuId: U } });
  await prisma.abroadSend.deleteMany({ where: { wawuUserId: U } });
  await prisma.abroadQuote.deleteMany({ where: { wawuUserId: U } });
  await prisma.abroadRecipient.deleteMany({ where: { wawuUserId: U } });
  await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: U } });
  await prisma.$disconnect();
});

beforeEach(() => {
  legCalls.length = 0;
  records.clear();
  refuse.clear();
  hooks.platform = undefined;
  hooks.beforeLeg = undefined;
  hooks.onFind = undefined;
});

describe('R2-1: a send that did not stand never goes back on the provider word alone', () => {
  it('failed, fee given back, then the provider says completed: the row stays failed, the fee stays given back, one row for finance however often it is said', async () => {
    const { id, row, transferId } = await sendWithFee();
    await sends.apply(
      id,
      transfer({ id: transferId, state: 'failed', providerStatus: 'failed' }),
    );
    const failed = await rowOf(id);
    expect(failed.status).toBe('failed');
    expect(failed.feeGivenBackAt).not.toBeNull();
    expect(backCalls(row.reference)).toHaveLength(1);

    const again = transfer({
      id: transferId,
      state: 'completed',
      providerStatus: 'successful',
    });
    await sends.apply(id, again);
    await sends.apply(id, again);
    const after = await rowOf(id);
    expect(after.status).toBe('failed');
    expect(after.completedAt?.getTime()).toBe(failed.completedAt?.getTime());
    expect(after.failureReason).toBe(failed.failureReason);
    expect(after.feeGivenBackAt?.getTime()).toBe(
      failed.feeGivenBackAt?.getTime(),
    );
    // The word is kept beside the row, where the admin list reads it.
    expect(after.providerStatus).toBe('successful');
    const held = await auditOf(id, 'send_contradicted');
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      adminId: 'system',
      subjectWawuId: U,
      detail: expect.objectContaining({
        statusBefore: 'failed',
        providerState: 'completed',
        feeGivenBack: true,
      }) as unknown,
    });
    // No second give-back, and a sweep leaves it as it is.
    await sends.sweep(new Date(Date.now() + 10 * 60_000));
    expect(backCalls(row.reference)).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('failed');
  });

  it('reversed, then the provider says completed or pending: the row stays reversed', async () => {
    const { id, transferId } = await sendWithFee();
    await sends.apply(
      id,
      transfer({
        id: transferId,
        state: 'reversed',
        providerStatus: 'reversed',
      }),
    );
    expect((await rowOf(id)).status).toBe('reversed');
    await sends.apply(
      id,
      transfer({ id: transferId, state: 'pending', providerStatus: 'new' }),
    );
    expect((await rowOf(id)).status).toBe('reversed');
    await sends.apply(
      id,
      transfer({
        id: transferId,
        state: 'completed',
        providerStatus: 'successful',
      }),
    );
    const after = await rowOf(id);
    expect(after.status).toBe('reversed');
    expect(after.completedAt).not.toBeNull();
    expect(await auditOf(id, 'send_contradicted')).toHaveLength(1);
  });

  it('what is allowed still is: a failed send the provider then reverses becomes reversed, with no second give-back', async () => {
    const { id, row, transferId } = await sendWithFee();
    await sends.apply(
      id,
      transfer({ id: transferId, state: 'failed', providerStatus: 'failed' }),
    );
    await sends.apply(
      id,
      transfer({
        id: transferId,
        state: 'reversed',
        providerStatus: 'reversed',
      }),
    );
    expect((await rowOf(id)).status).toBe('reversed');
    expect(backCalls(row.reference)).toHaveLength(1);
    expect(await auditOf(id, 'send_contradicted')).toHaveLength(0);
  });
});

describe('R2-2: finance paying a fee back outside and the sweep giving it back cannot both pay', () => {
  /** A failed send whose give-back the provider has refused so far: owed, not held, the sweep still trying. */
  async function owedBack() {
    const { id, row, transferId } = await sendWithFee();
    refuse.add(`${row.reference}-fee-back`);
    await sends.apply(
      id,
      transfer({ id: transferId, state: 'failed', providerStatus: 'failed' }),
    );
    refuse.clear();
    const owed = await rowOf(id);
    expect(owed.status).toBe('failed');
    expect(owed.feeGivenBackAt).toBeNull();
    expect(owed.feeBackHeldAt).toBeNull();
    expect(records.has(`${row.reference}-fee-back`)).toBe(false);
    return { id, row };
  }
  /** Lets the time the sweep's ask needs pass: the row says nothing touched it for ten minutes. */
  const quiet = (id: string) =>
    prisma.abroadSend.update({
      where: { id },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

  it('refuses "paid back outside" while the sweep has just asked for the leg, and allows it once the sweep has been quiet', async () => {
    const { id } = await owedBack();
    await expect(
      admin.settleFee(actor, id, 'paid_back', 'paid by finance'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await rowOf(id)).feeSettledAt).toBeNull();
    expect(await auditOf(id, 'fee_paid_back')).toHaveLength(0);
    await quiet(id);
    await expect(
      admin.settleFee(actor, id, 'paid_back', 'paid by finance'),
    ).resolves.toMatchObject({ how: 'paid_back_outside' });
  });

  it('refuses it while the leg is being made: the sweep is inside the provider call and nothing exists to read yet', async () => {
    const { id, row } = await owedBack();
    let during: unknown = 'not run';
    hooks.beforeLeg = async (reference) => {
      if (!reference.endsWith('-fee-back')) return;
      during = await admin
        .settleFee(actor, id, 'paid_back', 'paid by finance')
        .then(
          (v) => v,
          (e: unknown) => e,
        );
    };
    await sends.giveBack(id);
    expect(during).toBeInstanceOf(ConflictException);
    const after = await rowOf(id);
    expect(after.feeGivenBackAt).not.toBeNull();
    expect(after.feeSettledAt).toBeNull();
    expect(after.feeSettledHow).toBeNull();
    expect(await auditOf(id, 'fee_paid_back')).toHaveLength(0);
    expect(backCalls(row.reference)).toHaveLength(2);
    expect(records.get(`${row.reference}-fee-back`)?.outcome).toBe('completed');
  });

  it('makes no leg once finance has closed the fee, even when the sweep had already read the row', async () => {
    const { id, row } = await owedBack();
    await quiet(id);
    const asked = backCalls(row.reference).length;
    let settled: unknown = 'not run';
    // The sweep read the row as owed, then finance closes it before the sweep asks the provider for the leg.
    hooks.platform = async () => {
      hooks.platform = undefined;
      settled = await admin
        .settleFee(actor, id, 'paid_back', 'paid by finance')
        .then(
          (v) => v,
          (e: unknown) => e,
        );
    };
    await sends.giveBack(id);
    expect(settled).toMatchObject({ how: 'paid_back_outside' });
    expect(backCalls(row.reference)).toHaveLength(asked);
    expect(records.has(`${row.reference}-fee-back`)).toBe(false);
    const after = await rowOf(id);
    expect(after.feeSettledHow).toBe('paid_back_outside');
    expect(await auditOf(id, 'fee_paid_back')).toHaveLength(1);
  });

  it('does not close a fee the sweep touched after finance read it', async () => {
    const { id } = await owedBack();
    await quiet(id);
    // The sweep claims a pass between finance reading the row and closing it.
    hooks.onFind = async (reference) => {
      if (reference.endsWith('-fee-back')) {
        hooks.onFind = undefined;
        await prisma.abroadSend.update({
          where: { id },
          data: { feeBackAttempts: { increment: 1 } },
        });
      }
    };
    await expect(
      admin.settleFee(actor, id, 'paid_back', 'paid by finance'),
    ).rejects.toBeInstanceOf(ConflictException);
    const after = await rowOf(id);
    expect(after.feeSettledAt).toBeNull();
    expect(after.feeGivenBackAt).toBeNull();
    expect(await auditOf(id, 'fee_paid_back')).toHaveLength(0);
  });
});
