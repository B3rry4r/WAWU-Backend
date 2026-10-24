import { randomUUID } from 'node:crypto';
import { AccountDeletionMoneyService } from '../../../account/account-deletion-money.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  AbroadFeeLeg,
  AbroadFeeLegInput,
  AbroadFeeLegRef,
  AbroadProvider,
  AbroadTransfer,
} from '../../../wallet-provider/abroad-provider';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import {
  NO_NAIRA_ACCOUNT_MESSAGE,
  WalletGate,
  WORLD_WALLET_OK,
  type OpenWallet,
} from '../../gate/wallet-gate';
import { MoneyError } from '../../money-error';
import type {
  IdempotencyScope,
  IdempotencyService,
} from '../../payments/idempotency';
import { AbroadAdminService } from '../abroad-admin.service';
import { AbroadSendService } from '../abroad-send.service';
import { AbroadService } from '../abroad.service';
import type { AbroadSettings } from '../abroad-settings';
import { AbroadController } from '../abroad.controller';

/**
 * Sending abroad from a foreign account by a person with no naira wallet (WALLET-42, R-87), on a real database and a provider
 * double that is ours: the decisions the Hub makes. The Nuvion side (the holder with no naira wallet, the fee legs in a foreign
 * currency) is scripts/nuvion/world-abroad-check.ts against Nuvion DEV. Nothing here imports a second provider; the naira
 * provider calls throw, so a test that touched the naira wallet would fail.
 */

jest.setTimeout(60_000);

const prisma = new PrismaService();
const W = `w42-${randomUUID()}`;
const ENTITY = '01M5WORLD42TESTENTITY0000AB';
const COLLECTOR = '0011824002';
const world: OpenWallet = {
  wawuUserId: W,
  customerId: ENTITY,
  walletId: '',
  accountNumber: '',
};

class Settings {
  enabled = true;
  wawuFeeKobo = 2_500;
  foreignFees: Record<string, number> = {};
  collectors: Record<string, string> = {};
  wawuFeeMinor = (c: string, m: string) => this.foreignFees[`${c}|${m}`] ?? 0;
  feeCollectorBan = (c: string) => this.collectors[c] ?? null;
  providerFeeMinor = () => null;
  maxPerSend = () => null;
  maxPerDay = () => null;
  countriesOff = () => new Set<string>();
}
const settings = new Settings();

function transfer(over: Partial<AbroadTransfer> = {}): AbroadTransfer {
  return {
    id: `T${randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()}`,
    state: 'pending',
    providerStatus: 'new',
    providerReason: null,
    feeMinor: 0,
    currency: 'GBP',
    amountMinor: 10_000,
    reference: null,
    createdAt: null,
    ...over,
  };
}

/** The legs the provider was asked to make, and its record of each reference. */
const legCalls: AbroadFeeLegInput[] = [];
const legRecords = new Map<string, AbroadFeeLeg>();
const legPlan = new Map<string, 'fail' | 'pending'>();
/** Lets a test decide what the provider does with a reference before it is first asked. */
let legHook: ((i: AbroadFeeLegInput) => void) | null = null;
const sendCalls: Array<{
  holderWalletId: string;
  fromAccountRef: string;
  fromCurrency: string;
}> = [];
/** Anything that touches the naira wallet lands here. */
const nairaCalls: string[] = [];

const abroadSide: AbroadProvider = {
  banks: () => Promise.resolve([]),
  sources: () =>
    Promise.resolve([
      {
        currency: 'EUR',
        accountRef: 'ACC-EUR',
        displayName: null,
        availableMinor: 50_000,
      },
      {
        currency: 'GBP',
        accountRef: 'ACC-GBP',
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
  quote: (i) => {
    const same = i.fromCurrency === i.toCurrency;
    return Promise.resolve({
      quoteRef: same ? null : 'Q1',
      amountFromMinor: i.amountMinor,
      amountToMinor: same ? i.amountMinor : i.amountMinor * 10,
      rate: same ? null : '10',
      expiresAt: new Date(Date.now() + 180_000),
      validForSeconds: 180,
    });
  },
  send: (i) => {
    sendCalls.push({
      holderWalletId: i.holder.walletId,
      fromAccountRef: i.fromAccountRef,
      fromCurrency: i.fromCurrency,
    });
    return Promise.resolve(transfer({ currency: i.fromCurrency }));
  },
  read: () => Promise.resolve(transfer()),
  findByReference: () => Promise.resolve({ state: 'absent' as const }),
  feeLeg: (i) => {
    legHook?.(i);
    legCalls.push(i);
    const earlier = legRecords.get(i.reference);
    if (earlier) return Promise.resolve(earlier);
    const plan = legPlan.get(i.reference);
    const leg: AbroadFeeLeg = {
      state:
        plan === 'fail'
          ? 'failed'
          : plan === 'pending'
            ? 'pending'
            : 'completed',
      amountMinor: i.amountMinor,
      feeMinor: 0n,
    };
    legRecords.set(i.reference, leg);
    return Promise.resolve(leg);
  },
  findFeeLeg: (_ref: AbroadFeeLegRef, reference: string) => {
    const leg = legRecords.get(reference);
    return Promise.resolve(
      leg ? { state: 'found' as const, leg } : { state: 'absent' as const },
    );
  },
};

const provider = {
  name: 'nuvion',
  label: 'Nuvion',
  abroad: abroadSide,
  getPlatformAccount: () => {
    nairaCalls.push('getPlatformAccount');
    return Promise.reject(new Error('the naira wallet must not be touched'));
  },
  findTransactionByReference: () => {
    nairaCalls.push('findTransactionByReference');
    return Promise.reject(new Error('the naira wallet must not be touched'));
  },
  walletToWallet: () => {
    nairaCalls.push('walletToWallet');
    return Promise.reject(new Error('the naira wallet must not be touched'));
  },
  getBalance: () => Promise.resolve({ availableKobo: 0n, bookedKobo: 0n }),
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
const gate = new WalletGate(prisma);
const scope = (): IdempotencyScope => ({
  wawuUserId: W,
  method: 'POST',
  route: 'POST money/abroad/sends',
  key: randomUUID(),
  fingerprint: 'f',
});

const GH_MOMO = {
  country: 'GH',
  method: 'mobile_money' as const,
  scheme: 'mtn',
  holderName: 'Ama Mensah',
  fields: { phone_number: '+233241234567' },
};

const code = (e: unknown) => (e instanceof MoneyError ? e.code : String(e));
const refused = (p: Promise<unknown>) => p.then(() => 'no error', code);

async function recipientId(): Promise<string> {
  return (await abroad.saveRecipient(world, GH_MOMO)).view.id;
}

async function quote(
  fromCurrency = 'GBP',
  amountMinor = 10_000,
  recipient?: string,
) {
  return abroad.quote(world, {
    recipientId: recipient ?? (await recipientId()),
    fromCurrency,
    amountMinor,
  });
}

async function makeSend() {
  const q = await quote();
  const view = await sends.send(world, scope(), { quoteId: q.id });
  const row = await prisma.abroadSend.findUniqueOrThrow({
    where: { id: view.id },
  });
  return { q, view, row, transferId: row.providerTransferId! };
}

beforeAll(async () => {
  await prisma.$connect();
  await prisma.fintavaWalletOpening.create({
    data: {
      wawuUserId: W,
      state: 'open',
      bvnHash: `hash-${W}`,
      bvnVerifiedAt: new Date(),
      phone: `+4477${Math.floor(Math.random() * 1e8)}`,
      provider: 'nuvion',
      worldCountry: 'GB',
      worldFirstCurrency: 'GBP',
      worldAccountOpenedAt: new Date(),
    },
  });
  await prisma.nuvionEntity.create({
    data: { wawuUserId: W, entityId: ENTITY, status: 'approved' },
  });
});

afterAll(async () => {
  await prisma.abroadAdminAudit.deleteMany({ where: { subjectWawuId: W } });
  await prisma.abroadSend.deleteMany({ where: { wawuUserId: W } });
  await prisma.abroadQuote.deleteMany({ where: { wawuUserId: W } });
  await prisma.abroadRecipient.deleteMany({ where: { wawuUserId: W } });
  await prisma.nuvionEntity.deleteMany({ where: { wawuUserId: W } });
  await prisma.fintavaWalletOpening.deleteMany({ where: { wawuUserId: W } });
  await prisma.$disconnect();
});

beforeEach(() => {
  settings.enabled = true;
  settings.wawuFeeKobo = 2_500;
  settings.foreignFees = { 'GBP|mobile_money': 150, 'GBP|bank': 200 };
  settings.collectors = { GBP: COLLECTOR };
  legCalls.length = 0;
  legRecords.clear();
  legPlan.clear();
  legHook = null;
  sendCalls.length = 0;
  nairaCalls.length = 0;
});

describe('the gate lets a world wallet through the abroad routes, and nothing naira', () => {
  it('every abroad route takes a world wallet, and a naira route still refuses it', async () => {
    const proto = AbroadController.prototype as unknown as Record<
      string,
      unknown
    >;
    const routes = [
      'corridors',
      'banks',
      'sources',
      'recipients',
      'saveRecipient',
      'removeRecipient',
      'quote',
      'send',
      'sends',
      'sendById',
    ];
    for (const name of routes) {
      expect([
        name,
        Reflect.getMetadata(WORLD_WALLET_OK, proto[name] as object),
      ]).toEqual([name, true]);
    }
    // The gate every naira route runs refuses this person; the gate the abroad routes run lets them in, with no naira wallet.
    await expect(gate.requireOpen(W)).rejects.toMatchObject({
      response: {
        reason: { code: 'wallet_not_open', message: NO_NAIRA_ACCOUNT_MESSAGE },
      },
    });
    expect(await gate.requireOpenOrWorld(W)).toEqual(world);
  });

  it("finds a world person's holder for the sweep and the admin, with no naira wallet", async () => {
    expect(await abroad.holderOf(W)).toEqual({
      customerId: ENTITY,
      walletId: '',
    });
    expect(AbroadService.isWorld(world)).toBe(true);
  });
});

describe('a send in a currency the person does not hold is refused plainly', () => {
  it('refuses the naira wallet they do not have, and a dollar account they never opened', async () => {
    const id = await recipientId();
    for (const [from, words] of [
      [
        'NGN',
        'You have no naira account. Send from one of your other currency accounts.',
      ],
      ['USD', 'You do not have a USD account to send from.'],
    ]) {
      await expect(quote(from, 10_000, id)).rejects.toMatchObject({
        response: {
          reason: { code: 'fx_account_not_open', message: words },
        },
      });
    }
    expect(nairaCalls).toEqual([]);
  });

  it('counts the fee in the sending currency before the PIN, and says so when the account is short', async () => {
    const id = await recipientId();
    expect(await refused(quote('GBP', 99_900, id))).toBe('insufficient_funds');
    const ok = await quote('GBP', 99_850, id);
    expect(ok.wawuFeeMinor).toBe(150);
  });

  it('does not offer a fee it could not collect', async () => {
    settings.collectors = {};
    expect(await refused(quote())).toBe('currency_not_supported');
    settings.foreignFees = {};
    expect((await quote()).wawuFeeMinor).toBe(0);
  });
});

describe("a world person's send debits the foreign account, and only that", () => {
  it('quotes the fee from config per currency and way, in pence, never in kobo', async () => {
    const q = await quote();
    expect(q).toMatchObject({
      fromCurrency: 'GBP',
      wawuFeeMinor: 150,
      wawuFeeKobo: 0,
    });
    const row = await prisma.abroadQuote.findUniqueOrThrow({
      where: { id: q.id },
    });
    expect([row.wawuFeeMinor, row.wawuFeeKobo]).toEqual([150n, 0n]);
  });

  it('sends from the GBP account with no naira wallet id, takes the fee once from the same account, and never touches naira', async () => {
    const { view, row } = await makeSend();
    expect(sendCalls).toEqual([
      { holderWalletId: '', fromAccountRef: 'ACC-GBP', fromCurrency: 'GBP' },
    ]);
    expect(view).toMatchObject({ fromCurrency: 'GBP', wawuFeeMinor: 150 });
    expect(legCalls).toEqual([
      {
        holder: { customerId: ENTITY, walletId: '' },
        currency: 'GBP',
        accountRef: 'ACC-GBP',
        collectorBan: COLLECTOR,
        direction: 'take',
        amountMinor: 150n,
        reference: `${row.reference}-fee`,
        narration: 'WAWU fee',
      },
    ]);
    expect(
      (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
        .wawuFeeTaken,
    ).toBe(true);
    // The sweep and a second take change nothing: the fee left the account once.
    await sends.sweep();
    await sends.takeFee(view.id);
    expect(legCalls.filter((c) => c.direction === 'take')).toHaveLength(1);
    expect(nairaCalls).toEqual([]);
  });

  it('keeps a fee the provider has not finished, and takes it exactly once when it lands', async () => {
    const q = await quote();
    const ref = (id: string) => `wawu-abroad-${id}-fee`;
    legHook = (i) => {
      if (!legRecords.has(i.reference)) legPlan.set(i.reference, 'pending');
    };
    try {
      const view = await sends.send(world, scope(), { quoteId: q.id });
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .wawuFeeTaken,
      ).toBe(false);
      expect((await admin.get(view.id)).wawuFeeOwed).toBe(true);
      legRecords.set(ref(view.id), {
        state: 'completed',
        amountMinor: 150n,
        feeMinor: 0n,
      });
      await sends.sweep();
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .wawuFeeTaken,
      ).toBe(true);
      expect(legCalls.filter((c) => c.reference === ref(view.id))).toHaveLength(
        1,
      );
    } finally {
      legHook = null;
    }
  });

  it('replaces a fee reference the provider failed, as every fee leg does (the one set of legs)', async () => {
    const q = await quote();
    legHook = (i) => {
      if (i.reference.endsWith('-fee') && !legRecords.has(i.reference)) {
        legPlan.set(i.reference, 'fail');
      }
    };
    try {
      const view = await sends.send(world, scope(), { quoteId: q.id });
      const row = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(row.wawuFeeTaken).toBe(false);
      await sends.takeFee(view.id);
      expect(legCalls.map((c) => c.reference)).toEqual([
        `${row.reference}-fee`,
        `${row.reference}-fee-2`,
      ]);
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .wawuFeeTaken,
      ).toBe(true);
    } finally {
      legHook = null;
    }
  });
});

describe('the fee goes back exactly once when the send does not stand', () => {
  it.each(['failed', 'reversed'] as const)(
    'gives the GBP fee back to the same account once when the send %s, however often it is told',
    async (state) => {
      const { view, row, transferId } = await makeSend();
      const word = transfer({ id: transferId, state, providerStatus: state });
      await sends.apply(view.id, word);
      await sends.apply(view.id, word);
      await sends.sweep();
      await sends.sweep();
      await sends.giveBack(view.id);
      const back = legCalls.filter((c) => c.direction === 'give_back');
      expect(back).toEqual([
        {
          holder: { customerId: ENTITY, walletId: '' },
          currency: 'GBP',
          accountRef: 'ACC-GBP',
          collectorBan: COLLECTOR,
          direction: 'give_back',
          amountMinor: 150n,
          reference: `${row.reference}-fee-back`,
          narration: 'WAWU fee given back',
        },
      ]);
      const after = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(after.feeGivenBackAt).not.toBeNull();
      expect(nairaCalls).toEqual([]);
    },
  );

  it('shows finance the give-back that is still owed in the foreign currency, and settles it once', async () => {
    const { view, row, transferId } = await makeSend();
    legHook = (i) => {
      if (i.direction === 'give_back' && !legRecords.has(i.reference)) {
        legPlan.set(i.reference, 'fail');
      }
    };
    try {
      await sends.apply(
        view.id,
        transfer({
          id: transferId,
          state: 'reversed',
          providerStatus: 'reversed',
        }),
      );
      const owed = await admin.get(view.id);
      expect(owed).toMatchObject({
        wawuFeeMinor: 150,
        wawuFeeBackOwed: true,
        fromCurrency: 'GBP',
      });
      // The fee leg is read from the foreign account's record, not the naira wallet's.
      expect(await sends.readFeeLeg(row, 'fee')).toMatchObject({
        result: 'done',
      });
    } finally {
      legHook = null;
    }
    expect(nairaCalls).toEqual([]);
  });
});

describe('deletion and the record', () => {
  it('holds an account deletion while a send abroad is unfinished, for a person with no naira wallet', async () => {
    const deletion = new AccountDeletionMoneyService(provider, prisma);
    // The sends the earlier tests left open are decided, so what holds the deletion is the one made here.
    await prisma.abroadSend.updateMany({
      where: { wawuUserId: W },
      data: {
        status: 'completed',
        wawuFeeTaken: true,
        feeSettledAt: new Date(),
        feeSettledHow: 'nothing_taken',
      },
    });
    const { view, transferId } = await makeSend();
    const blockers = async () => (await deletion.check(W)).blockers;
    expect(await blockers()).toContain('payment_in_progress');
    await sends.apply(
      view.id,
      transfer({
        id: transferId,
        state: 'completed',
        providerStatus: 'successful',
      }),
    );
    expect(await blockers()).not.toContain('payment_in_progress');
    // A reversed send whose fee has not gone back yet is a payment with no final answer too (the give-back is refused here).
    const second = await makeSend();
    legHook = (i) => {
      if (i.direction === 'give_back' && !legRecords.has(i.reference)) {
        legPlan.set(i.reference, 'fail');
      }
    };
    try {
      await sends.apply(
        second.view.id,
        transfer({
          id: second.transferId,
          state: 'reversed',
          providerStatus: 'reversed',
        }),
      );
      expect(await blockers()).toContain('payment_in_progress');
    } finally {
      legHook = null;
    }
    await sends.sweep(new Date(Date.now() + 5 * 60_000));
    expect(await blockers()).not.toContain('payment_in_progress');
  });
});
