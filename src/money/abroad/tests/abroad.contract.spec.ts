import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NuvionError } from '../../../nuvion/nuvion-error';
import {
  AbroadRefusal,
  type AbroadProvider,
  type AbroadTransfer,
} from '../../../wallet-provider/abroad-provider';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import type { OpenWallet } from '../../gate/wallet-gate';
import { MoneyError } from '../../money-error';
import type {
  IdempotencyScope,
  IdempotencyService,
} from '../../payments/idempotency';
import { AbroadAdminService } from '../abroad-admin.service';
import { AbroadSendService } from '../abroad-send.service';
import { AbroadService } from '../abroad.service';
import type { AbroadSettings } from '../abroad-settings';

/**
 * Sending abroad, the Hub's side (NUV-11), on a real database and a provider
 * double that is ours, not a model of Nuvion (that is nuvion-abroad.spec.ts):
 * the decisions the Hub makes with whatever the provider says.
 */

jest.setTimeout(60_000);

const prisma = new PrismaService();
const U = `u-${randomUUID()}`;
const V = `v-${randomUUID()}`;
const wallet = (id: string): OpenWallet => ({
  wawuUserId: id,
  customerId: `E${id.slice(0, 20)}`.toUpperCase(),
  walletId:
    `E${id.slice(0, 20)}`.toUpperCase() + ':A' + id.slice(0, 20).toUpperCase(),
  accountNumber: `00${Math.floor(Math.random() * 1e8)}`,
});

class Settings {
  enabled = true;
  wawuFeeKobo = 0;
  perSend: Record<string, number> = {};
  perDay: Record<string, number> = {};
  off = new Set<string>();
  partnerFees: Record<string, number> = {};
  providerFeeMinor = (src: string, dest: string, method: string) =>
    this.partnerFees[`${src}|${dest}|${method}`] ?? null;
  maxPerSend = (c: string) => this.perSend[c] ?? null;
  maxPerDay = (c: string) => this.perDay[c] ?? null;
  countriesOff = () => this.off;
}

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

class FakeAbroad implements AbroadProvider {
  calls: string[] = [];
  sendImpl: () => Promise<AbroadTransfer> = () => Promise.resolve(transfer());
  lookup: 'found' | 'absent' | 'unknown' = 'absent';
  found: AbroadTransfer = transfer({
    state: 'completed',
    providerStatus: 'successful',
  });
  readImpl: () => Promise<AbroadTransfer> = () => Promise.resolve(this.found);
  recipients = 0;
  banks() {
    return Promise.resolve([]);
  }
  sources() {
    return Promise.resolve([
      {
        currency: 'NGN',
        accountRef: 'ACC-NGN',
        displayName: null,
        availableMinor: 5_000_000,
      },
      {
        currency: 'USD',
        accountRef: 'ACC-USD',
        displayName: null,
        availableMinor: 100_000,
      },
    ]);
  }
  saveRecipient() {
    this.recipients += 1;
    return Promise.resolve({
      counterpartyId: 'CP1',
      paymentDetailId: `PD${this.recipients}`,
      bankName: 'Test Bank',
    });
  }
  quote(i: {
    fromCurrency: string;
    toCurrency: string;
    amountMinor: number;
    side: 'send' | 'receive';
  }) {
    const same = i.fromCurrency === i.toCurrency;
    return Promise.resolve({
      quoteRef: same ? null : 'Q1',
      amountFromMinor:
        i.side === 'send'
          ? i.amountMinor
          : same
            ? i.amountMinor
            : i.amountMinor * 2,
      amountToMinor:
        i.side === 'send'
          ? same
            ? i.amountMinor
            : Math.floor(i.amountMinor / 2)
          : i.amountMinor,
      rate: same ? null : '0.5',
      expiresAt: new Date(Date.now() + 180_000),
      validForSeconds: 180,
    });
  }
  send() {
    this.calls.push('send');
    return this.sendImpl();
  }
  read() {
    return this.readImpl();
  }
  findByReference() {
    return Promise.resolve(
      this.lookup === 'found'
        ? { state: 'found' as const, transfer: this.found }
        : { state: this.lookup },
    );
  }
}

const settings = new Settings();
const abroadSide = new FakeAbroad();
type LegInput = {
  fromAccountNumber: string;
  toAccountNumber: string;
  amountKobo: bigint;
  reference: string;
  narration?: string;
};
/** Every leg the provider was asked to make, in order (a refused or lost ask is here too). */
const feeCalls: LegInput[] = [];
/** The provider's own record of each leg, found again by reference, as the book area's is. */
const records = new Map<
  string,
  { outcome: 'completed' | 'failed' | 'pending'; input: LegInput }
>();
/** What the provider does with a reference the first time it is asked: complete (default), fail it, leave it pending, or refuse it. */
const plan = new Map<string, 'fail' | 'pending' | 'refuse'>();
let feeFails = false;
const provider = {
  name: 'nuvion',
  label: 'Nuvion',
  abroad: abroadSide,
  getPlatformAccount: () => Promise.resolve({ accountNumber: 'PLATFORM' }),
  findTransactionByReference: (reference: string) => {
    const rec = records.get(reference);
    return Promise.resolve(
      rec
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
        : { state: 'absent' as const },
    );
  },
  walletToWallet: (i: LegInput) => {
    if (feeFails) {
      return Promise.reject(
        new NuvionError({
          kind: 'unavailable',
          operation: 'x',
          recordMayExist: false,
        }),
      );
    }
    feeCalls.push(i);
    const earlier = records.get(i.reference);
    if (earlier) {
      // A repeat of a reference answers with the first record, whatever it was.
      if (earlier.outcome === 'failed') {
        return Promise.reject(
          new NuvionError({
            kind: 'refused',
            operation: 'x',
            providerFailed: true,
            recordMayExist: true,
          }),
        );
      }
      return Promise.resolve({
        amountKobo: i.amountKobo,
        totalKobo: i.amountKobo,
        feeKobo: 0n,
        pending: earlier.outcome === 'pending',
      });
    }
    const what = plan.get(i.reference);
    if (what === 'refuse') {
      return Promise.reject(
        new NuvionError({
          kind: 'refused',
          operation: 'x',
          recordMayExist: false,
        }),
      );
    }
    const outcome =
      what === 'fail' ? 'failed' : what === 'pending' ? 'pending' : 'completed';
    records.set(i.reference, { outcome, input: i });
    if (outcome === 'failed') {
      return Promise.reject(
        new NuvionError({
          kind: 'refused',
          operation: 'x',
          providerFailed: true,
          recordMayExist: true,
        }),
      );
    }
    return Promise.resolve({
      amountKobo: i.amountKobo,
      totalKobo: i.amountKobo,
      feeKobo: 0n,
      pending: outcome === 'pending',
    });
  },
} as unknown as WalletProvider;

const keyCalls: string[] = [];
const keys = {
  attach: () => Promise.resolve(),
  finish: () => {
    keyCalls.push('finish');
    return Promise.resolve();
  },
  release: () => {
    keyCalls.push('release');
    return Promise.resolve();
  },
} as unknown as IdempotencyService;

const abroad = new AbroadService(
  prisma,
  provider,
  settings as unknown as AbroadSettings,
);
const sends = new AbroadSendService(prisma, provider, abroad, keys);
const admin = new AbroadAdminService(prisma, provider, abroad, sends);
const scope = (): IdempotencyScope => ({
  wawuUserId: U,
  method: 'POST',
  route: 'POST money/abroad/sends',
  key: randomUUID(),
  fingerprint: 'f',
});
const actor = { id: 'admin-1', email: 'fin@wawu.africa', role: 'finance' };

const GH_BANK = {
  country: 'GH',
  method: 'bank' as const,
  holderName: 'Ama Mensah',
  fields: { bank: '030100', account_number: '0123 4567 89' },
};

let me: OpenWallet;
let other: OpenWallet;

beforeAll(async () => {
  await prisma.$connect();
  me = wallet(U);
  other = wallet(V);
  for (const w of [me, other]) {
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: w.wawuUserId,
        customerId: w.customerId,
        walletId: w.walletId,
        accountNumber: w.accountNumber,
        provider: 'nuvion',
      },
    });
  }
});

afterAll(async () => {
  await prisma.abroadAdminAudit.deleteMany({
    where: { subjectWawuId: { in: [U, V] } },
  });
  await prisma.abroadSend.deleteMany({ where: { wawuUserId: { in: [U, V] } } });
  await prisma.abroadQuote.deleteMany({
    where: { wawuUserId: { in: [U, V] } },
  });
  await prisma.abroadRecipient.deleteMany({
    where: { wawuUserId: { in: [U, V] } },
  });
  await prisma.abroadFreeze.deleteMany({
    where: { wawuUserId: { in: [U, V] } },
  });
  await prisma.fintavaWallet.deleteMany({
    where: { wawuUserId: { in: [U, V] } },
  });
  await prisma.$disconnect();
});

beforeEach(() => {
  settings.enabled = true;
  settings.wawuFeeKobo = 0;
  settings.perSend = {};
  settings.perDay = {};
  settings.off = new Set();
  settings.partnerFees = {};
  abroadSide.sendImpl = () => Promise.resolve(transfer());
  abroadSide.lookup = 'absent';
  feeCalls.length = 0;
  feeFails = false;
  records.clear();
  plan.clear();
  keyCalls.length = 0;
});

async function recipient(w = me, fields = GH_BANK.fields) {
  return (await abroad.saveRecipient(w, { ...GH_BANK, fields })).view;
}

async function quoteFor(
  recipientId: string,
  over: {
    fromCurrency?: string;
    amountMinor?: number;
    side?: 'send' | 'receive';
  } = {},
) {
  return abroad.quote(me, {
    recipientId,
    fromCurrency: over.fromCurrency ?? 'USD',
    amountMinor: over.amountMinor ?? 10_000,
    side: over.side,
  });
}

/** `expect.stringContaining` and `arrayContaining` are typed `any`; these say what they stand for. */
const contains = (s: string): string => expect.stringContaining(s) as string;
const containing = (a: string[]): string[] =>
  expect.arrayContaining(a) as string[];

/** Lets the time a send needs to be looked for pass (the row says it was made ten minutes ago). */
async function age(id: string) {
  const before = new Date(Date.now() - 10 * 60_000);
  await prisma.abroadSend.update({
    where: { id },
    data: { attemptedAt: before, createdAt: before },
  });
}

const code = (e: unknown) => (e instanceof MoneyError ? e.code : String(e));
const refused = async (p: Promise<unknown>) => p.then(() => 'no error', code);

describe('what can be drawn', () => {
  it('lists the countries with the exact fields of each way, and draws none when off', () => {
    const v = abroad.corridors();
    expect(v.enabled).toBe(true);
    const gh = v.countries.find((c) => c.country === 'GH')!;
    expect(gh.currency).toBe('GHS');
    expect(gh.rails.map((r) => r.method)).toEqual(['bank', 'mobile_money']);
    expect(gh.rails[0].schemes[0].fields.map((f) => f.key)).toEqual([
      'bank',
      'account_number',
    ]);
    expect(gh.rails[1].schemes.map((s) => s.id)).toEqual([
      'mtn',
      'vodafone',
      'airtel',
    ]);
    const us = v.countries.find((c) => c.country === 'US')!;
    expect(us.rails[0].schemes.map((s) => s.id)).toEqual([
      'ach',
      'wire',
      'rtp',
    ]);
    expect(us.rails[0].schemes[0].fields.map((f) => f.key)).toContain(
      'account_type',
    );
    const ca = v.countries.find((c) => c.country === 'CA')!;
    expect(
      ca.rails[0].schemes
        .find((s) => s.id === 'interac_email')!
        .fields.map((f) => f.key),
    ).toEqual(['email']);
    settings.off = new Set(['GH']);
    expect(
      abroad.corridors().countries.find((c) => c.country === 'GH'),
    ).toMatchObject({
      available: false,
      unavailableNote: contains('cannot send'),
    });
    settings.enabled = false;
    expect(abroad.corridors()).toMatchObject({ enabled: false, countries: [] });
  });
});

describe('recipients', () => {
  it('asks for exactly the corridor fields, and names the ones that are wrong', async () => {
    await expect(
      abroad.saveRecipient(me, { ...GH_BANK, fields: { bank: '030100' } }),
    ).rejects.toMatchObject({
      response: {
        reason: {
          code: 'recipient_details_invalid',
          fields: ['account_number'],
        },
      },
    });
    await expect(
      abroad.saveRecipient(me, {
        ...GH_BANK,
        fields: { ...GH_BANK.fields, sort_code: '123456' },
      }),
    ).rejects.toMatchObject({
      response: { reason: { fields: ['sort_code'] } },
    });
    await expect(
      abroad.saveRecipient(me, {
        country: 'US',
        method: 'bank',
        scheme: 'ach',
        holderName: 'Dan Brooks',
        fields: {
          bank_name: 'B',
          routing_number: '12',
          account_number: '987654321012',
          account_type: 'current',
          bank_address_line1: 'x',
          bank_address_city: 'y',
          bank_address_state: 'z',
          bank_address_postal_code: '1',
        },
      }),
    ).rejects.toMatchObject({
      response: {
        reason: {
          fields: containing(['routing_number', 'account_type']),
        },
      },
    });
    expect(
      await refused(
        abroad.saveRecipient(me, {
          ...GH_BANK,
          country: 'GH',
          method: 'bank',
          scheme: 'mtn',
        }),
      ),
    ).toBe('recipient_details_invalid');
    expect(
      await refused(abroad.saveRecipient(me, { ...GH_BANK, country: 'ZZ' })),
    ).toBe('corridor_not_supported');
  });

  it('keeps only the last four of the account and tells a repeat without keeping it', async () => {
    const before = abroadSide.recipients;
    const first = await abroad.saveRecipient(me, GH_BANK);
    expect(first.created).toBe(true);
    expect(first.view).toMatchObject({
      last4: '6789',
      countryName: 'Ghana',
      bankName: 'Test Bank',
    });
    expect(first.view.summary).toBe('Ghana, Bank account, ending 6789');
    const again = await abroad.saveRecipient(me, {
      ...GH_BANK,
      fields: { bank: '030100', account_number: '0123456789' },
    });
    expect(again).toMatchObject({ created: false });
    expect(again.view.id).toBe(first.view.id);
    expect(abroadSide.recipients).toBe(before + 1);
    const row = await prisma.abroadRecipient.findUniqueOrThrow({
      where: { id: first.view.id },
    });
    expect(JSON.stringify(row)).not.toContain('0123456789');
    // Removed, then saved again: the same one comes back.
    await abroad.removeRecipient(U, first.view.id);
    expect(
      (await abroad.listRecipients(U)).items.map((r) => r.id),
    ).not.toContain(first.view.id);
    const back = await abroad.saveRecipient(me, GH_BANK);
    expect(back.view.id).toBe(first.view.id);
    expect(abroadSide.recipients).toBe(before + 1);
    expect(await refused(abroad.removeRecipient(V, first.view.id))).toBe(
      'not_found',
    );
  });

  it('refuses a country that is switched off, and the whole product when it is off', async () => {
    settings.off = new Set(['GH']);
    expect(await refused(abroad.saveRecipient(me, GH_BANK))).toBe(
      'corridor_not_supported',
    );
    settings.off = new Set();
    settings.enabled = false;
    expect(await refused(abroad.saveRecipient(me, GH_BANK))).toBe(
      'fx_switched_off',
    );
  });
});

describe('quotes and limits', () => {
  it('quotes a conversion from a dollar account and from the naira wallet, and holds it', async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    expect(q).toMatchObject({
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      amountFromMinor: 10_000,
      amountToMinor: 5_000,
      converted: true,
      rate: '0.5',
      providerFeeMinor: null,
      wawuFeeKobo: 0,
      speed: 'Same day',
    });
    const exact = await quoteFor(r.id, { side: 'receive', amountMinor: 5_000 });
    expect(exact).toMatchObject({
      amountToMinor: 5_000,
      amountFromMinor: 10_000,
    });
    expect(await refused(quoteFor(r.id, { fromCurrency: 'EUR' }))).toBe(
      'fx_account_not_open',
    );
    expect(
      await refused(
        abroad.quote(me, {
          recipientId: randomUUID(),
          fromCurrency: 'USD',
          amountMinor: 5000,
        }),
      ),
    ).toBe('not_found');
  });

  it('keeps to the corridor range and to the least Nuvion takes', async () => {
    const r = await recipient();
    await expect(quoteFor(r.id, { amountMinor: 150 })).rejects.toMatchObject({
      response: {
        reason: {
          code: 'amount_out_of_range',
          minimumMinor: 100,
          currency: 'GHS',
        },
      },
    });
    const momo = (
      await abroad.saveRecipient(me, {
        country: 'GH',
        method: 'mobile_money',
        scheme: 'mtn',
        holderName: 'Kofi A',
        fields: { phone_number: '+233 24 123 4567' },
      })
    ).view;
    // Docs: GHS mobile money 5 to 25,000 (500 to 2,500,000 pesewas).
    await expect(
      quoteFor(momo.id, { amountMinor: 400 * 2 }),
    ).rejects.toMatchObject({
      response: { reason: { code: 'amount_out_of_range', minimumMinor: 500 } },
    });
  });

  it('applies the per-send and per-day most an admin set, and not enough money', async () => {
    const r = await recipient();
    settings.perSend = { USD: 5_000 };
    await expect(quoteFor(r.id)).rejects.toMatchObject({
      response: {
        reason: {
          code: 'amount_out_of_range',
          maximumMinor: 5_000,
          currency: 'USD',
        },
      },
    });
    settings.perSend = {};
    await expect(
      quoteFor(r.id, { amountMinor: 200_000 }),
    ).rejects.toMatchObject({
      response: {
        reason: {
          code: 'insufficient_funds',
          balanceMinor: 100_000,
          shortfallMinor: 100_000,
        },
      },
    });
    // The fee comes out of the naira wallet on top of a naira send.
    settings.wawuFeeKobo = 1_000;
    await expect(
      quoteFor(r.id, { fromCurrency: 'NGN', amountMinor: 4_999_500 }),
    ).rejects.toMatchObject({
      response: {
        reason: { code: 'insufficient_funds', totalMinor: 5_000_500 },
      },
    });
  });

  it('is refused while the person is frozen, with nothing else asked of the provider', async () => {
    const r = await recipient();
    const f = await admin.freeze(actor, U, 'checking a report');
    expect(f).toMatchObject({ frozen: true, reason: 'checking a report' });
    expect(await refused(quoteFor(r.id))).toBe('account_frozen');
    expect(await refused(sends.checkBeforePin(U, undefined))).toBe(
      'account_frozen',
    );
    await admin.freeze(actor, U, 'again');
    expect(
      await prisma.abroadAdminAudit.count({
        where: { subjectWawuId: U, action: 'person_frozen' },
      }),
    ).toBe(1);
    await admin.unfreeze(actor, U, 'cleared');
    await admin.unfreeze(actor, U, 'again');
    expect(
      await prisma.abroadAdminAudit.count({
        where: { subjectWawuId: U, action: 'person_unfrozen' },
      }),
    ).toBe(1);
    await expect(quoteFor(r.id)).resolves.toBeDefined();
  });
});

describe('the send', () => {
  it("sends once at a held quote, records the provider's word, and refuses the quote a second time", async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    const view = await sends.send(me, scope(), {
      quoteId: q.id,
      narration: 'school fees',
    });
    expect(view).toMatchObject({
      status: 'pending',
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      amountFromMinor: 10_000,
      amountToMinor: 5_000,
      providerFeeMinor: 0,
      narration: 'school fees',
    });
    expect(view.recipient.last4).toBe('6789');
    const row = await prisma.abroadSend.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.reference).toBe(`wawu-abroad-${view.id}`);
    expect(row.providerTransferId).toBeTruthy();
    expect(keyCalls).toEqual(['finish']);
    expect(await refused(sends.send(me, scope(), { quoteId: q.id }))).toBe(
      'quote_expired',
    );
    expect(keyCalls).toContain('release');
    // Another person cannot use it, and sees nothing of it.
    expect(await refused(sends.send(other, scope(), { quoteId: q.id }))).toBe(
      'not_found',
    );
    expect(await refused(sends.read(V, view.id))).toBe('not_found');
    expect((await sends.read(U, view.id)).id).toBe(view.id);
  });

  it('leaves no send and gives the quote back when the provider says no', async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    abroadSide.sendImpl = () =>
      Promise.reject(
        new AbroadRefusal(
          'insufficient_funds',
          'There is not enough money in that account for this send.',
        ),
      );
    expect(await refused(sends.send(me, scope(), { quoteId: q.id }))).toBe(
      'insufficient_funds',
    );
    expect(await prisma.abroadSend.count({ where: { quoteId: q.id } })).toBe(0);
    expect(
      (await prisma.abroadQuote.findUniqueOrThrow({ where: { id: q.id } }))
        .usedAt,
    ).toBeNull();
    abroadSide.sendImpl = () => Promise.resolve(transfer());
    await expect(
      sends.send(me, scope(), { quoteId: q.id }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('keeps a send whose answer was lost as sending, and never sends it twice', async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    abroadSide.calls = [];
    abroadSide.sendImpl = () =>
      Promise.reject(
        new NuvionError({
          kind: 'outcome_unknown',
          operation: 'abroad transfer',
          recordMayExist: true,
        }),
      );
    const view = await sends.send(me, scope(), { quoteId: q.id });
    expect(view.status).toBe('sending');
    expect(abroadSide.calls).toEqual(['send']);

    // Not yet due: nothing is asked.
    expect(await sends.sweep(new Date())).toMatchObject({ checked: 0 });
    // Due, and the provider holds it: the send becomes the provider's.
    abroadSide.lookup = 'found';
    abroadSide.found = transfer({
      state: 'completed',
      providerStatus: 'successful',
      feeMinor: 25,
    });
    const later = new Date(Date.now() + 2 * 60_000);
    await sends.sweep(later);
    const done = await sends.read(U, view.id);
    expect(done).toMatchObject({ status: 'completed', providerFeeMinor: 25 });
    expect(done.completedAt).not.toBeNull();
    expect(abroadSide.calls).toEqual(['send']);
  });

  it('waits for a person when the provider holds no record after half an hour, and lets finance cancel it', async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    abroadSide.sendImpl = () =>
      Promise.reject(
        new NuvionError({
          kind: 'outcome_unknown',
          operation: 'abroad transfer',
          recordMayExist: true,
        }),
      );
    const view = await sends.send(me, scope(), { quoteId: q.id });
    await age(view.id);
    abroadSide.lookup = 'absent';
    await sends.sweep(new Date(Date.now() + 31 * 60_000));
    expect((await sends.read(U, view.id)).status).toBe('needs_review');

    // The provider cannot be asked: refused.
    abroadSide.lookup = 'unknown';
    expect(await refused(admin.cancel(actor, view.id, 'no record'))).toBe(
      'send_not_cancellable',
    );
    // It turns out the provider holds it: refused, and the send takes the provider's state.
    abroadSide.lookup = 'found';
    abroadSide.found = transfer({
      state: 'pending',
      providerStatus: 'pending',
    });
    expect(await refused(admin.cancel(actor, view.id, 'no record'))).toBe(
      'send_not_cancellable',
    );
    expect((await sends.read(U, view.id)).status).toBe('pending');
    expect(
      await prisma.abroadAdminAudit.count({ where: { sendId: view.id } }),
    ).toBe(0);
  });

  it('cancels a send the provider never had, once, with an audit row', async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    abroadSide.sendImpl = () =>
      Promise.reject(
        new NuvionError({
          kind: 'outcome_unknown',
          operation: 'abroad transfer',
          recordMayExist: true,
        }),
      );
    const view = await sends.send(me, scope(), { quoteId: q.id });
    // Seconds old, the provider may still be taking it: not cancellable yet (F3).
    expect(await refused(admin.cancel(actor, view.id, 'too soon'))).toBe(
      'send_not_cancellable',
    );
    expect(
      await prisma.abroadAdminAudit.count({ where: { sendId: view.id } }),
    ).toBe(0);
    await age(view.id);
    abroadSide.lookup = 'absent';
    expect(
      await admin.cancel(actor, view.id, 'confirmed with the partner'),
    ).toEqual({ id: view.id, status: 'cancelled' });
    expect(await admin.cancel(actor, view.id, 'again')).toEqual({
      id: view.id,
      status: 'cancelled',
    });
    const audit = await prisma.abroadAdminAudit.findMany({
      where: { sendId: view.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'send_cancelled',
      adminEmail: actor.email,
      adminRole: 'finance',
      reason: 'confirmed with the partner',
    });
    expect((await sends.read(U, view.id)).failureReason).toContain(
      'Nothing was taken',
    );
    // A send the provider accepted cannot be cancelled.
    const q2 = await quoteFor(r.id);
    abroadSide.sendImpl = () => Promise.resolve(transfer());
    const held = await sends.send(me, scope(), { quoteId: q2.id });
    expect(await refused(admin.cancel(actor, held.id, 'x'))).toBe(
      'send_not_cancellable',
    );
  });

  it('applies the per-day most under the lock', async () => {
    const r = await recipient();
    const sent = Number(await abroad.sentToday(prisma, U, 'USD'));
    settings.perDay = { USD: sent + 15_000 };
    const q1 = await quoteFor(r.id);
    const q2 = await quoteFor(r.id);
    await sends.send(me, scope(), { quoteId: q1.id });
    await expect(
      sends.send(me, scope(), { quoteId: q2.id }),
    ).rejects.toMatchObject({
      response: {
        reason: { code: 'daily_limit_exceeded', remainingTodayMinor: 5_000 },
      },
    });
  });

  it('follows the provider to failed and to reversed, and never takes a completed send back to pending', async () => {
    const r = await recipient();
    const q = await quoteFor(r.id);
    const view = await sends.send(me, scope(), { quoteId: q.id });
    const id = (
      await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } })
    ).providerTransferId!;
    await sends.apply(
      view.id,
      transfer({ id, state: 'completed', providerStatus: 'successful' }),
    );
    await sends.apply(
      view.id,
      transfer({ id, state: 'pending', providerStatus: 'pending' }),
    );
    expect((await sends.read(U, view.id)).status).toBe('completed');
    await sends.apply(
      view.id,
      transfer({ id, state: 'reversed', providerStatus: 'reversed' }),
    );
    expect(await sends.read(U, view.id)).toMatchObject({
      status: 'reversed',
      failureReason: contains('returned'),
    });
    const q2 = await quoteFor(r.id);
    const v2 = await sends.send(me, scope(), { quoteId: q2.id });
    const id2 = (
      await prisma.abroadSend.findUniqueOrThrow({ where: { id: v2.id } })
    ).providerTransferId!;
    await sends.apply(
      v2.id,
      transfer({ id: id2, state: 'failed', providerStatus: 'failed' }),
    );
    expect(await sends.read(U, v2.id)).toMatchObject({
      status: 'failed',
      failureReason: contains('could not deliver'),
    });
  });

  it("takes WAWU's fee from the naira wallet after the provider has the send, and tries again when it cannot", async () => {
    settings.wawuFeeKobo = 2_500;
    const r = await recipient();
    const q = await quoteFor(r.id);
    expect(q.wawuFeeKobo).toBe(2_500);
    const view = await sends.send(me, scope(), { quoteId: q.id });
    expect(view.wawuFeeKobo).toBe(2_500);
    expect(feeCalls).toEqual([
      {
        amountKobo: 2_500n,
        reference: `wawu-abroad-${view.id}-fee`,
        fromAccountNumber: me.accountNumber,
        toAccountNumber: 'PLATFORM',
        narration: 'WAWU fee',
      },
    ]);
    expect(
      (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
        .wawuFeeTaken,
    ).toBe(true);

    feeFails = true;
    feeCalls.length = 0;
    const q2 = await quoteFor(r.id);
    const v2 = await sends.send(me, scope(), { quoteId: q2.id });
    const owed = await admin.get(v2.id);
    expect(owed.wawuFeeOwed).toBe(true);
    feeFails = false;
    await sends.sweep();
    expect(feeCalls).toHaveLength(1);
    expect((await admin.get(v2.id)).wawuFeeOwed).toBe(false);
  });

  it("pages a person's sends newest first, and the admin list filters", async () => {
    const page1 = await sends.list(U, undefined, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await sends.list(U, page1.nextCursor!, 2);
    expect(page2.items[0].id).not.toBe(page1.items[1].id);
    const all = await admin.list({ wawuUserId: U, status: 'cancelled' });
    expect(
      all.items.every((s) => s.status === 'cancelled' && s.wawuUserId === U),
    ).toBe(true);
    expect(all.items.length).toBeGreaterThan(0);
  });

  describe("WAWU's fee after a send that did not stand (F1)", () => {
    const back = (ref: string, attempt = 1) =>
      `${ref}-fee-back${attempt === 1 ? '' : `-${attempt}`}`;
    async function sendWithFee() {
      settings.wawuFeeKobo = 2_500;
      const r = await recipient();
      const q = await quoteFor(r.id);
      const view = await sends.send(me, scope(), { quoteId: q.id });
      const row = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: view.id },
      });
      return { view, row, id: row.providerTransferId! };
    }
    const legs = (ref: string) =>
      feeCalls.filter((c) => c.reference.startsWith(ref));

    it('gives the fee back exactly once when the send fails, from WAWU to the person, and never says it did before it landed', async () => {
      const { view, row, id } = await sendWithFee();
      expect(records.get(`${row.reference}-fee`)?.outcome).toBe('completed');
      await sends.apply(
        view.id,
        transfer({ id, state: 'failed', providerStatus: 'failed' }),
      );
      expect(legs(back(row.reference))).toEqual([
        {
          fromAccountNumber: 'PLATFORM',
          toAccountNumber: me.accountNumber,
          amountKobo: 2_500n,
          reference: back(row.reference),
          narration: 'WAWU fee given back',
        },
      ]);
      const after = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(after.feeGivenBackAt).not.toBeNull();
      // Applying the same word again, and a sweep, send nothing more.
      await sends.apply(
        view.id,
        transfer({ id, state: 'failed', providerStatus: 'failed' }),
      );
      await sends.sweep(new Date(Date.now() + 10 * 60_000));
      expect(
        feeCalls.filter((c) => c.reference.includes('-fee-back')),
      ).toHaveLength(1);
    });

    it('gives it back when a completed send is reversed afterwards, and not for a send that completed', async () => {
      const { view, row, id } = await sendWithFee();
      await sends.apply(
        view.id,
        transfer({ id, state: 'completed', providerStatus: 'successful' }),
      );
      expect(
        feeCalls.filter((c) => c.reference.includes('-fee-back')),
      ).toHaveLength(0);
      await sends.apply(
        view.id,
        transfer({ id, state: 'reversed', providerStatus: 'reversed' }),
      );
      expect(legs(back(row.reference))).toHaveLength(1);
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .feeGivenBackAt,
      ).not.toBeNull();
    });

    it('is never marked given back unless the provider completed it: a failed give-back is tried again under a new reference in a later pass, and a pending one waits for its record', async () => {
      const { view, row, id } = await sendWithFee();
      plan.set(back(row.reference), 'fail');
      await sends.apply(
        view.id,
        transfer({ id, state: 'failed', providerStatus: 'failed' }),
      );
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .feeGivenBackAt,
      ).toBeNull();
      expect(legs(back(row.reference))).toHaveLength(1);
      // The next pass sees the first reference spent and uses the second.
      plan.set(back(row.reference, 2), 'pending');
      await sends.sweep(new Date(Date.now() + 5 * 60_000));
      expect(legs(back(row.reference, 2))).toHaveLength(1);
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .feeGivenBackAt,
      ).toBeNull();
      // The provider finishes it: the next pass reads that and marks it, sending nothing new.
      records.set(back(row.reference, 2), {
        outcome: 'completed',
        input: feeCalls[feeCalls.length - 1],
      });
      await sends.sweep(new Date(Date.now() + 10 * 60_000));
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } }))
          .feeGivenBackAt,
      ).not.toBeNull();
      expect(
        feeCalls.filter((c) => c.reference.includes('-fee-back')),
      ).toHaveLength(2);
      expect(legs(back(row.reference, 3))).toHaveLength(0);
    });

    it('owes nothing when no fee was taken: a fee of nothing, and a fee leg the provider failed', async () => {
      const r = await recipient();
      const q = await quoteFor(r.id);
      const free = await sends.send(me, scope(), { quoteId: q.id });
      const freeRow = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: free.id },
      });
      await sends.apply(
        free.id,
        transfer({
          id: freeRow.providerTransferId!,
          state: 'failed',
          providerStatus: 'failed',
        }),
      );
      expect(feeCalls).toHaveLength(0);

      settings.wawuFeeKobo = 2_500;
      const q2 = await quoteFor(r.id);
      plan.set(`wawu-abroad-NONE`, 'fail');
      feeFails = true;
      const v2 = await sends.send(me, scope(), { quoteId: q2.id });
      feeFails = false;
      const row2 = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: v2.id },
      });
      expect(row2.wawuFeeTaken).toBe(false);
      await sends.apply(
        v2.id,
        transfer({
          id: row2.providerTransferId!,
          state: 'failed',
          providerStatus: 'failed',
        }),
      );
      expect(
        feeCalls.filter((c) => c.reference.includes('-fee-back')),
      ).toHaveLength(0);
      expect(
        (await prisma.abroadSend.findUniqueOrThrow({ where: { id: v2.id } }))
          .feeGivenBackAt,
      ).toBeNull();
    });

    it('holds a give-back that cannot be made for a day for a person, still owed, and sends nothing more', async () => {
      const { view, row, id } = await sendWithFee();
      for (const n of [1, 2, 3]) plan.set(back(row.reference, n), 'fail');
      await sends.apply(
        view.id,
        transfer({ id, state: 'failed', providerStatus: 'failed' }),
      );
      await sends.sweep(new Date(Date.now() + 5 * 60_000));
      await sends.sweep(new Date(Date.now() + 10 * 60_000));
      await sends.sweep(new Date(Date.now() + 25 * 3_600_000));
      const held = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(held.feeGivenBackAt).toBeNull();
      expect(held.feeBackHeldAt).not.toBeNull();
      expect((await admin.get(view.id)).wawuFeeBackOwed).toBe(true);
      const sent = feeCalls.filter((c) =>
        c.reference.includes('-fee-back'),
      ).length;
      await sends.sweep(new Date(Date.now() + 26 * 3_600_000));
      expect(
        feeCalls.filter((c) => c.reference.includes('-fee-back')),
      ).toHaveLength(sent);
    });
  });

  describe('round 1 findings', () => {
    it("F3: a cancelled send is never reopened by the provider's word, and the cancel leaves one audit row", async () => {
      const r = await recipient();
      const q = await quoteFor(r.id);
      abroadSide.sendImpl = () =>
        Promise.reject(
          new NuvionError({
            kind: 'outcome_unknown',
            operation: 'abroad transfer',
            recordMayExist: true,
          }),
        );
      const view = await sends.send(me, scope(), { quoteId: q.id });
      await age(view.id);
      abroadSide.lookup = 'absent';
      await admin.cancel(actor, view.id, 'confirmed with the partner');
      // The provider takes it after all (a call that was in flight): the row stays cancelled, the provider's facts are kept beside it.
      const held = transfer({ state: 'pending', providerStatus: 'pending' });
      const after = await sends.apply(view.id, held);
      expect(after.status).toBe('cancelled');
      expect(after.providerTransferId).toBe(held.id);
      expect(after.providerStatus).toBe('pending');
      await sends.apply(
        view.id,
        transfer({
          id: held.id,
          state: 'completed',
          providerStatus: 'successful',
        }),
      );
      expect((await sends.read(U, view.id)).status).toBe('cancelled');
      expect(
        await prisma.abroadAdminAudit.count({ where: { sendId: view.id } }),
      ).toBe(1);
    });

    it('F7: a country switched off after the quote was taken is not sent to, before the PIN and at the send', async () => {
      const r = await recipient();
      const q = await quoteFor(r.id);
      settings.off = new Set(['GH']);
      expect(await refused(sends.checkBeforePin(U, q.id))).toBe(
        'corridor_not_supported',
      );
      expect(await refused(sends.send(me, scope(), { quoteId: q.id }))).toBe(
        'corridor_not_supported',
      );
      expect(await prisma.abroadSend.count({ where: { quoteId: q.id } })).toBe(
        0,
      );
      settings.off = new Set();
      await expect(
        sends.send(me, scope(), { quoteId: q.id }),
      ).resolves.toMatchObject({ status: 'pending' });
    });

    it("F2: the partner's fee from config is shown on the quote, counted in the funds check, and kept on the send", async () => {
      settings.partnerFees = { 'USD|GHS|bank': 150 };
      const r = await recipient();
      const q = await quoteFor(r.id);
      expect(q).toMatchObject({
        providerFeeMinor: 150,
        amountFromMinor: 10_000,
      });
      // USD 1,000.00 is all the account holds (the fake's balance is 100,000 cents): the amount alone fits, with the fee it does not.
      await expect(
        quoteFor(r.id, { amountMinor: 99_900 }),
      ).rejects.toMatchObject({
        response: {
          reason: {
            code: 'insufficient_funds',
            balanceMinor: 100_000,
            totalMinor: 100_050,
            shortfallMinor: 50,
          },
        },
      });
      await expect(
        quoteFor(r.id, { amountMinor: 99_800 }),
      ).resolves.toMatchObject({ providerFeeMinor: 150 });
      // A corridor with no figure is not estimated.
      expect(
        (await quoteFor(r.id, { fromCurrency: 'NGN', amountMinor: 1_000_000 }))
          .providerFeeMinor,
      ).toBeNull();
      const view = await sends.send(me, scope(), { quoteId: q.id });
      const row = await prisma.abroadSend.findUniqueOrThrow({
        where: { id: view.id },
      });
      expect(row.providerFeeEstimateMinor).toBe(150n);
    });

    it('F2: a real fee that is not the one shown flags the send for admin, and one that is does not', async () => {
      settings.partnerFees = { 'USD|GHS|bank': 150 };
      const r = await recipient();
      const q = await quoteFor(r.id);
      const view = await sends.send(me, scope(), { quoteId: q.id });
      const id = (
        await prisma.abroadSend.findUniqueOrThrow({ where: { id: view.id } })
      ).providerTransferId!;
      await sends.apply(view.id, transfer({ id, feeMinor: 150 }));
      expect(await admin.get(view.id)).toMatchObject({
        feeDiffers: false,
        providerFeeEstimateMinor: 150,
        providerFeeMinor: 150,
      });
      await sends.apply(view.id, transfer({ id, feeMinor: 200 }));
      expect(await admin.get(view.id)).toMatchObject({
        feeDiffers: true,
        providerFeeMinor: 200,
      });
      // No figure configured: a charge above nothing is a difference; nothing charged is not.
      settings.partnerFees = {};
      const q2 = await quoteFor(r.id);
      const v2 = await sends.send(me, scope(), { quoteId: q2.id });
      const id2 = (
        await prisma.abroadSend.findUniqueOrThrow({ where: { id: v2.id } })
      ).providerTransferId!;
      await sends.apply(v2.id, transfer({ id: id2, feeMinor: 0 }));
      expect((await admin.get(v2.id)).feeDiffers).toBe(false);
      await sends.apply(v2.id, transfer({ id: id2, feeMinor: 25 }));
      expect((await admin.get(v2.id)).feeDiffers).toBe(true);
    });
  });
});
