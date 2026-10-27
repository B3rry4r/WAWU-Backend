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
};

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

  async function clean() {
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
    const provider = {
      name: 'nuvion',
      label: 'Nuvion',
      configured: true,
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
    accounts = new FxAccountsService(
      new FxPort(provider),
      prisma,
      {} as FxSettings,
    );
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
