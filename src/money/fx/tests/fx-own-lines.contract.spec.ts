import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ProviderFxStatementLine } from '../../../wallet-provider/wallet-provider-fx';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import type { OpenWallet } from '../../gate/wallet-gate';
import { FxAccountsService } from '../fx-accounts.service';
import { FxPort } from '../fx-provider';
import type { FxSettings } from '../fx-settings';

/**
 * FIX-P6 L2 (CHECK-3 sixth pass, 19-wallet-after-unlock.png): the history of a
 * foreign account is read from the provider's statement, and the provider names
 * the other side of a payment by WAWU's own internal account ("WAWU operational
 * (held money)"). A person never reads WAWU's internal account names: a line
 * WAWU made (a payment, its conversion fee, a refund) is named by what it was
 * for, the way the naira row is ("Unlock", then the piece), from WAWU's own
 * records.
 */

const USER = 'fp6-fx-user-1';
const OTHER = 'fp6-fx-user-2';
const WALLET: OpenWallet = {
  wawuUserId: USER,
  customerId: '01FP6ENTITY00000000000000A',
  walletId: '',
  accountNumber: '',
};
const INTERNAL = 'WAWU operational (held money)';

const ids = {
  unlock: randomUUID(),
  tip: randomUUID(),
  question: randomUUID(),
  ticket: randomUUID(),
  foreign: randomUUID(),
  gone: randomUUID(),
  holdQuestion: randomUUID(),
  holdForeign: randomUUID(),
  viaId: randomUUID(),
  otherViaId: randomUUID(),
  fx: randomUUID(),
  abroad: randomUUID(),
};
/** The provider's transfer ids our own records hold (the statement's line id is the provider's transfer id). */
const TRANSFER_MINE = '01FP6TRANSFER0000000000MINE';
const TRANSFER_OTHER = '01FP6TRANSFER000000000OTHER';

function line(over: Partial<ProviderFxStatementLine>): ProviderFxStatementLine {
  return {
    id: randomUUID(),
    direction: 'out',
    status: 'completed',
    amountMinor: 23n,
    feeMinor: 0n,
    balanceAfterMinor: 100n,
    description: 'WAWU purchase',
    counterpartyName: INTERNAL,
    reference: '',
    occurredAt: new Date().toISOString(),
    conversion: null,
    ...over,
  };
}

describe('a foreign account history never shows a WAWU internal account name (FIX-P6 L2)', () => {
  const prisma = new PrismaService();
  let accounts: FxAccountsService;
  let accountId: string;
  let statement: ProviderFxStatementLine[] = [];

  async function payment(
    id: string,
    kind: string,
    title: string,
    payer: string,
  ) {
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: payer,
        kind,
        targetId: `target-${id}`,
        title,
        payeeWawuUserId: null,
        priceKobo: 30_000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 30_000n,
        payeeShareKobo: 25_500n,
        wawuShareKobo: 4_500n,
        customerReference: `wawu-pay-${id}`,
        payerAccountNumber: null,
        merchantAccountNumber: 'MERCHANT-FP6',
        provider: 'nuvion',
        status: 'completed',
        sourceCurrency: 'USD',
      },
    });
  }

  /** The service over a fake provider whose statement is `statement`; `platform` is the operational account's own display name (null: the provider cannot say). */
  function build(platform: string | null): FxAccountsService {
    const provider = {
      name: 'nuvion',
      label: 'Nuvion',
      configured: true,
      ...(platform === null
        ? {
            getPlatformAccount: () => Promise.reject(new Error('no answer')),
          }
        : {
            getPlatformAccount: () =>
              Promise.resolve({
                accountNumber: '0099990001',
                accountName: platform,
                availableKobo: 0n,
                bookedKobo: 0n,
              }),
          }),
      fx: {
        statement: (
          _person: unknown,
          _account: unknown,
          query: { cursor: string | null },
        ) =>
          Promise.resolve({
            lines: query.cursor ? [] : statement,
            nextCursor: null,
          }),
      },
    } as unknown as WalletProvider;
    return new FxAccountsService(
      new FxPort(provider),
      prisma,
      {} as FxSettings,
    );
  }

  async function clean() {
    await prisma.walletPaymentFx.deleteMany({
      where: { payment: { payerWawuUserId: { in: [USER, OTHER] } } },
    });
    await prisma.walletHold.deleteMany({
      where: { payerWawuUserId: { in: [USER, OTHER] } },
    });
    await prisma.walletPayment.deleteMany({
      where: { payerWawuUserId: { in: [USER, OTHER] } },
    });
    await prisma.fxAccount.deleteMany({
      where: { wawuUserId: { in: [USER, OTHER] } },
    });
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await clean();
    accounts = build(INTERNAL);
    const row = await prisma.fxAccount.create({
      data: {
        wawuUserId: USER,
        provider: 'nuvion',
        currency: 'USD',
        chain: '',
        providerCustomerId: WALLET.customerId,
        providerAccountId: '01FP6ACCOUNT0000000000000A',
        ban: '0123456789',
        status: 'open',
      },
    });
    accountId = row.id;

    await payment(ids.unlock, 'content_unlock', 'Lighting night shoots', USER);
    await payment(ids.tip, 'tip', 'Tip to Cleo Okafor', USER);
    await payment(ids.question, 'paid_dm', 'Question for Cleo Okafor', USER);
    await payment(ids.ticket, 'event_ticket', 'Lagos Photo Walk', USER);
    // Another person's payment: its title is never read into this person's history.
    await payment(
      ids.foreign,
      'content_unlock',
      "Somebody else's piece",
      OTHER,
    );
    await payment(ids.viaId, 'tip', 'Tip on Lagos Photo Walk', USER);
    await payment(ids.otherViaId, 'tip', "Somebody else's tip", OTHER);
    for (const [paymentId, transferId] of [
      [ids.viaId, TRANSFER_MINE],
      [ids.otherViaId, TRANSFER_OTHER],
    ]) {
      await prisma.walletPaymentFx.create({
        data: {
          paymentId,
          sourceCurrency: 'USD',
          fxAccountId: accountId,
          providerAccountId: '01FP6ACCOUNT0000000000000A',
          fxQuoteId: `quote-${paymentId}`,
          providerQuoteId: `pq-${paymentId}`,
          rate: '1315.44',
          sourceAmountMinor: 23n,
          providerTransferId: transferId,
        },
      });
    }
    await prisma.walletHold.create({
      data: {
        id: ids.holdForeign,
        paymentId: ids.foreign,
        payerWawuUserId: OTHER,
        payeeWawuUserId: null,
        kind: 'content_unlock',
        targetId: `target-${ids.foreign}`,
        title: "Somebody else's piece",
        releaseCondition: 'bill_delivered',
        amountKobo: 30_000n,
        payeeShareKobo: 25_500n,
        wawuShareKobo: 4_500n,
        merchantAccountNumber: 'MERCHANT-FP6',
        provider: 'nuvion',
        status: 'refunded',
        heldAt: new Date(),
        settledAt: new Date(),
        refundedKobo: 30_000n,
        transferKobo: 30_000n,
        action: 'refund',
        customerReference: `wawu-ref-${ids.holdForeign}`,
      },
    });
    await prisma.walletHold.create({
      data: {
        id: ids.holdQuestion,
        paymentId: ids.question,
        payerWawuUserId: USER,
        payeeWawuUserId: null,
        kind: 'paid_dm',
        targetId: `target-${ids.question}`,
        title: 'Question for Cleo Okafor',
        releaseCondition: 'dm_answered',
        amountKobo: 30_000n,
        payeeShareKobo: 25_500n,
        wawuShareKobo: 4_500n,
        merchantAccountNumber: 'MERCHANT-FP6',
        provider: 'nuvion',
        status: 'refunded',
        heldAt: new Date(),
        settledAt: new Date(),
        refundedKobo: 30_000n,
        transferKobo: 30_000n,
        action: 'refund',
        customerReference: `wawu-ref-${ids.holdQuestion}`,
      },
    });
  });

  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  async function read() {
    const page = await accounts.transactions(WALLET, accountId, { limit: 50 });
    return Object.fromEntries(page.items.map((i) => [i.id, i]));
  }

  it('names a content unlock, a tip, a paid question and a ticket by what was paid for, as the naira row does', async () => {
    const unlock = line({ reference: `wawu-pay-${ids.unlock}` });
    const tip = line({ reference: `wawu-pay-${ids.tip}` });
    const question = line({ reference: `wawu-pay-${ids.question}` });
    const ticket = line({ reference: `wawu-pay-${ids.ticket}` });
    statement = [unlock, tip, question, ticket];
    const rows = await read();
    expect(rows[unlock.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Unlock · Lighting night shoots',
    });
    expect(rows[tip.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Tip · Tip to Cleo Okafor',
    });
    expect(rows[question.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Paid question · Question for Cleo Okafor',
    });
    expect(rows[ticket.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Event ticket · Lagos Photo Walk',
    });
  });

  it("names a refund and WAWU's conversion fee by what they were for", async () => {
    const refund = line({
      direction: 'in',
      description: 'Book transfer',
      reference: `book-transfer-inflow-for-wawu-ref-${ids.holdQuestion}`,
    });
    const fee = line({
      description: 'WAWU fee',
      reference: `wawu-pay-${ids.unlock}-fee`,
      amountMinor: 5n,
    });
    statement = [refund, fee];
    const rows = await read();
    expect(rows[refund.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Refund · Question for Cleo Okafor',
    });
    expect(rows[fee.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Conversion fee · Lighting night shoots',
    });
  });

  it("a line of WAWU's own whose record is gone, another person's, or not under our reference, still shows no internal name", async () => {
    const gone = line({ reference: `wawu-pay-${ids.gone}` });
    const foreign = line({ reference: `wawu-pay-${ids.foreign}` });
    const narrationOnly = line({
      reference: 'BT-0009',
      description: 'WAWU purchase',
    });
    const refundOnly = line({
      direction: 'in',
      description: 'WAWU refund',
      reference: 'BT-0010',
    });
    statement = [gone, foreign, narrationOnly, refundOnly];
    const rows = await read();
    for (const l of [gone, foreign, narrationOnly]) {
      expect(rows[l.id]).toMatchObject({
        counterpartyName: 'Who Made This',
        description: 'Payment',
      });
    }
    expect(rows[refundOnly.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Refund',
    });
    expect(JSON.stringify(rows)).not.toContain("Somebody else's piece");
  });

  it("leaves what is not WAWU's own as the provider says it: money from a person, and a swap", async () => {
    const fromAda = line({
      direction: 'in',
      description: 'Rent',
      counterpartyName: 'Ada Okoro',
      reference: 'ACH-77',
    });
    const swap = line({
      description: 'WAWU swap',
      counterpartyName: 'Own account',
      reference: 'wawu-fxop-1',
      conversion: {
        fromCurrency: 'USD',
        toCurrency: 'NGN',
        rate: '1315.44',
        fromMinor: 100n,
        toMinor: 131_544n,
      },
    });
    statement = [fromAda, swap];
    const rows = await read();
    expect(rows[fromAda.id]).toMatchObject({
      counterpartyName: 'Ada Okoro',
      description: 'Rent',
    });
    expect(rows[swap.id]).toMatchObject({
      counterpartyName: 'Own account',
      description: 'WAWU swap',
    });
    expect(rows[swap.id].conversion).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Round 2 (the verifier's findings): what a stranger controls is never trusted,
  // a WAWU line that matches nothing never shows the provider's name, and a
  // payment's rate block stays.
  // -------------------------------------------------------------------------

  const strangerWords = (l: ProviderFxStatementLine) => ({
    counterpartyName: l.counterpartyName,
    description: l.description,
  });

  it('M1: money from a person is never relabelled, whatever its narration or reference says', async () => {
    const ada = (over: Partial<ProviderFxStatementLine>) =>
      line({ direction: 'in', counterpartyName: 'Ada Okoro', ...over });
    const lines = [
      ada({ description: 'WAWU refund', reference: 'ACH-1' }),
      ada({ description: 'WAWU purchase', reference: 'ACH-2' }),
      ada({ description: 'WAWU fee', reference: 'ACH-3' }),
      ada({ description: 'Rent', reference: `wawu-pay-${ids.unlock}` }),
      // a stranger who cites the owner's real hold reference
      ada({
        description: 'Rent',
        reference: `book-transfer-inflow-for-wawu-ref-${ids.holdQuestion}`,
      }),
      // a person's own account carries a name WAWU gave it: it is theirs, not WAWU's operational account
      ada({
        description: 'WAWU refund',
        counterpartyName: 'WAWU USD 1a2b3c4d',
        reference: 'ACH-6',
      }),
      line({
        direction: 'out',
        description: 'WAWU purchase',
        counterpartyName: 'Ada Okoro',
        reference: 'ACH-7',
      }),
      // text a stranger controls that merely mentions an internal name
      ada({ description: 'WAWU operational (held money)', reference: 'ACH-8' }),
    ];
    statement = lines;
    const rows = await read();
    for (const l of lines) {
      expect(strangerWords(rows[l.id] as never)).toEqual(strangerWords(l));
    }
  });

  it('M1: a payment reference is taken only for a debit, a refund reference only for a credit, and only in the exact format WAWU writes', async () => {
    const credit = line({
      direction: 'in',
      reference: `wawu-pay-${ids.unlock}`,
    });
    const debit = line({
      direction: 'out',
      reference: `wawu-ref-${ids.holdQuestion}`,
    });
    const padded = line({ reference: `xx-wawu-pay-${ids.unlock}-yy` });
    const longer = line({ reference: `wawu-pay-${ids.unlock}-feeX` });
    statement = [credit, debit, padded, longer];
    const rows = await read();
    // still WAWU's own line, so the provider's name never shows, but what it was for is not claimed
    expect(rows[credit.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Refund',
    });
    for (const l of [debit, padded, longer]) {
      expect(rows[l.id]).toMatchObject({
        counterpartyName: 'Who Made This',
        description: 'Payment',
      });
    }
    expect(JSON.stringify(rows)).not.toContain('Lighting night shoots');
    expect(JSON.stringify(rows)).not.toContain('Question for Cleo');
  });

  it("another person's reference or transfer id never lends this person's history its title", async () => {
    const foreignRef = line({
      direction: 'in',
      reference: `book-transfer-inflow-for-wawu-ref-${ids.holdForeign}`,
    });
    const foreignId = line({ id: TRANSFER_OTHER, reference: 'zz-1' });
    statement = [foreignRef, foreignId];
    const rows = await read();
    expect(rows[foreignRef.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Refund',
    });
    expect(rows[foreignId.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Payment',
    });
    expect(JSON.stringify(rows)).not.toContain('Somebody else');
  });

  it('a line is named by the transfer id our own payment record holds, whatever its reference says, and only in the direction of that move', async () => {
    const mine = line({ id: TRANSFER_MINE, reference: 'zz-2' });
    statement = [mine];
    let rows = await read();
    expect(rows[mine.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Tip · Tip on Lagos Photo Walk',
    });
    const backwards = line({
      id: TRANSFER_MINE,
      direction: 'in',
      reference: 'zz-3',
    });
    statement = [backwards];
    rows = await read();
    expect(rows[backwards.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Refund',
    });
  });

  it("M2: a WAWU line that matches no record never shows the provider's name for WAWU's own account, by direction", async () => {
    const lines = [
      line({ description: 'Book transfer', reference: 'BT-5' }),
      line({
        description: 'Transfer to WAWU',
        counterpartyName: 'WAWU merchant',
        reference: 'x',
      }),
      line({
        direction: 'in',
        description: 'Credit',
        counterpartyName: 'WAWU Collector',
        reference: 'BT-6',
      }),
      line({
        description: 'WAWU fee',
        counterpartyName: 'WAWU collector',
        reference: 'BT-7',
      }),
      line({
        description: 'Book transfer to WAWU operational',
        counterpartyName: null,
        reference: 'BT-8',
      }),
      line({
        direction: 'in',
        description: 'Book transfer',
        counterpartyName: 'WAWU',
        reference: 'BT-9',
      }),
    ];
    statement = lines;
    const rows = await read();
    const want = [
      'Payment',
      'Payment',
      'Refund',
      'Conversion fee',
      'Payment',
      'Refund',
    ];
    lines.forEach((l, i) => {
      expect(rows[l.id]).toMatchObject({
        counterpartyName: 'Who Made This',
        description: want[i],
      });
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /operational|merchant|collector|held money/i,
    );
  });

  it("M2: the operational account's own display name, as the provider reads it, is WAWU's own whatever it is called, and a provider that cannot say still has the names the adapter uses", async () => {
    const desk = line({
      description: 'Book transfer',
      counterpartyName: 'Operations Desk',
      reference: 'BT-10',
    });
    statement = [desk];
    const named = build('Operations Desk (held money)');
    let page = await named.transactions(WALLET, accountId, { limit: 50 });
    expect(page.items[0]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Payment',
    });
    // not told by the provider: a name nobody here knows stays as it is, the adapter's own names do not
    const blind = build(null);
    page = await blind.transactions(WALLET, accountId, { limit: 50 });
    expect(page.items[0].counterpartyName).toBe('Operations Desk');
    const known = line({ counterpartyName: INTERNAL, reference: 'BT-11' });
    statement = [known];
    page = await blind.transactions(WALLET, accountId, { limit: 50 });
    expect(page.items[0].counterpartyName).toBe('Who Made This');
  });

  it("a swap's fee and a send's fee keep the provider's description (main's names), with WAWU's account hidden; only a payment's conversion fee reads Conversion fee", async () => {
    const swapFee = line({
      description: 'WAWU fee',
      counterpartyName: 'WAWU collector',
      reference: `wawu-fx-${ids.fx}-fee`,
    });
    const swapFeeRetry = line({
      description: 'WAWU fee',
      counterpartyName: 'WAWU collector',
      reference: `wawu-fx-${ids.fx}-fee-2`,
    });
    const sendFee = line({
      description: 'WAWU fee',
      counterpartyName: 'WAWU collector',
      reference: `wawu-abroad-${ids.abroad}-fee`,
    });
    const sendFeeBack = line({
      direction: 'in',
      description: 'WAWU fee given back',
      counterpartyName: 'WAWU collector',
      reference: `wawu-abroad-${ids.abroad}-fee-back`,
    });
    const paymentFee = line({
      description: 'WAWU fee',
      counterpartyName: 'WAWU collector',
      reference: `wawu-pay-${ids.unlock}-fee`,
    });
    statement = [swapFee, swapFeeRetry, sendFee, sendFeeBack, paymentFee];
    const rows = await read();
    for (const l of [swapFee, swapFeeRetry, sendFee, sendFeeBack]) {
      expect(rows[l.id]).toMatchObject({
        counterpartyName: 'Who Made This',
        description: l.description,
      });
    }
    expect(rows[paymentFee.id].description).toBe(
      'Conversion fee · Lighting night shoots',
    );
  });

  it("a payment keeps the provider's rate block, and nothing else of the line changes but its two words", async () => {
    const conversion = {
      fromCurrency: 'USD',
      toCurrency: 'NGN',
      rate: '1315.44',
      fromMinor: 23n,
      toMinor: 30_000n,
    };
    const paid = line({
      reference: `wawu-pay-${ids.unlock}`,
      conversion,
    });
    statement = [paid];
    const rows = await read();
    expect(rows[paid.id]).toMatchObject({
      counterpartyName: 'Who Made This',
      description: 'Unlock · Lighting night shoots',
      conversion: {
        fromCurrency: 'USD',
        toCurrency: 'NGN',
        rate: '1315.44',
        fromMinor: 23,
        toMinor: 30_000,
      },
      amountMinor: 23,
      direction: 'out',
      status: 'completed',
      reference: `wawu-pay-${ids.unlock}`,
    });
  });

  it('no row of a whole history carries the internal account name, whatever the lines are', async () => {
    statement = [
      line({ reference: `wawu-pay-${ids.unlock}` }),
      line({ reference: `wawu-pay-${ids.gone}` }),
      line({ reference: 'BT-1', description: 'WAWU fee' }),
      line({
        direction: 'in',
        reference: `book-transfer-inflow-for-wawu-ref-${ids.holdQuestion}`,
      }),
    ];
    const page = await accounts.transactions(WALLET, accountId, { limit: 50 });
    expect(page.items).toHaveLength(4);
    const text = JSON.stringify(page.items);
    expect(text).not.toMatch(
      /operational|held money|WAWU purchase|WAWU fee|WAWU refund/i,
    );
  });
});
