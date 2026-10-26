/**
 * PAY-FX's dev proof (R-91), against Nuvion's DEV only, through the Hub's own
 * routes: a dollar buyer with no naira account pays a naira price, WAWU's
 * naira account receives exactly the price, the payee's 85% is owed as for
 * any sale, a held ticket paid in dollars is refunded to the dollar account,
 * and a naira buyer pays the way they always did.
 *
 *   set -a; . <dev env file>; set +a
 *   DATABASE_URL=postgresql://...pfx_hub_test... WAWU_ID_JWKS_URL=... WAWU_ID_BASE_URL=... \
 *   PFX_BUYER_ENTITY=<dev entity with a USD account and no naira account> PFX_BUYER_USD=<its USD account id> \
 *   PFX_BUYER_BAN=<its routing number> PFX_NAIRA_ENTITY=<dev entity with naira> PFX_NAIRA_ACCOUNT=<its naira account id> \
 *   PFX_PAYEE_ENTITY=<dev entity> PFX_PAYEE_ACCOUNT=<its naira account id> \
 *   [PFX_FEE_MINOR=5 PFX_FEE_COLLECTOR_ACCOUNT=<WAWU's dev USD account id> PFX_FEE_COLLECTOR_BAN=<its routing number>] \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/pay-fx-dev-check.ts
 *
 * Refuses any base URL but https://api.nuvion.dev and any database that is not
 * a test one. The key is read from the environment and never printed; ids print
 * as their last four. Dev money only (a few cents and a few hundred naira).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  bootPfxApp,
  mintToken,
  PFX_CREATOR,
  registerPfxItems,
} from '../../test/payments/pay-fx-harness';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { WalletHoldService } from '../../src/money/holds/wallet-hold.service';
import { EarningSettlementService } from '../../src/money/earnings/earning-settlement.service';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../src/money/money-view.type';
import { PayableRegistry } from '../../src/money/payments/payable-registry';
import { NuvionAccountsArea } from '../../src/nuvion/areas/accounts';
import { PrismaNuvionBookStore } from '../../src/nuvion/areas/book-store';
import { NuvionClient } from '../../src/nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../src/nuvion/nuvion-config';
import {
  nuvionAreas,
  NuvionWalletProvider,
} from '../../src/nuvion/nuvion-wallet-provider';

const PIN = '5937';
const PRICE = 30_000;
const tail = (v: string | null | undefined) => (v ? `...${v.slice(-4)}` : '-');
const rows: Array<[string, boolean, string]> = [];
const row = (name: string, ok: boolean, detail: string) => {
  rows.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

async function main(): Promise<number> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NUVION_BASE_URL: process.env.NUVION_BASE_URL || NUVION_SANDBOX_BASE_URL,
    NUVION_WEBHOOK_SECRET:
      process.env.NUVION_WEBHOOK_SECRET || 'unused-by-this-check',
  };
  if (
    (env.NUVION_BASE_URL ?? '').replace(/\/+$/, '') !== NUVION_SANDBOX_BASE_URL
  ) {
    console.error(
      `Refused: this check runs against ${NUVION_SANDBOX_BASE_URL} only.`,
    );
    return 2;
  }
  if (!/pfx.*test|test.*pfx/.test(env.DATABASE_URL ?? '')) {
    console.error('Refused: DATABASE_URL must be a pfx test database.');
    return 2;
  }
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is needed`);
    return v;
  };
  const buyerEntity = need('PFX_BUYER_ENTITY');
  const buyerUsd = need('PFX_BUYER_USD');
  const buyerBan = need('PFX_BUYER_BAN');
  const nairaEntity = need('PFX_NAIRA_ENTITY');
  const nairaAccount = need('PFX_NAIRA_ACCOUNT');
  const payeeEntity = need('PFX_PAYEE_ENTITY');
  const payeeAccount = need('PFX_PAYEE_ACCOUNT');

  // WAWU's conversion fee above 0 (cents), collected into WAWU's own dev dollar account.
  const feeMinor = Number(env.PFX_FEE_MINOR ?? '0');
  const feeAccount = env.PFX_FEE_COLLECTOR_ACCOUNT;
  const feeBan = env.PFX_FEE_COLLECTOR_BAN;
  if (feeMinor > 0 && (!feeAccount || !feeBan)) {
    console.error(
      'Refused: a fee needs PFX_FEE_COLLECTOR_ACCOUNT and PFX_FEE_COLLECTOR_BAN.',
    );
    return 2;
  }
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const client = new NuvionClient(settings, apiKey);
  const prisma = new PrismaService();
  const provider = new NuvionWalletProvider(
    client,
    nuvionAreas(client, { bookStore: new PrismaNuvionBookStore(prisma) }),
  );
  const booted = await bootPfxApp(provider, {
    NUVION_BASE_URL: NUVION_SANDBOX_BASE_URL,
    NUVION_API_KEY: apiKey,
    NUVION_OPERATIONAL_ACCOUNT_ID: settings.operationalAccountId,
    NUVION_WEBHOOK_SECRET: env.NUVION_WEBHOOK_SECRET!,
    ...(feeMinor > 0
      ? {
          PAYMENT_FX_FEE_USD_MINOR: String(feeMinor),
          FX_FEE_COLLECTOR_USD_BAN: feeBan!,
        }
      : {}),
  });
  const app = booted.app;
  const users: string[] = [];
  const delivered: Array<{
    paymentId: string;
    kind: string;
    targetId: string;
  }> = [];
  try {
    const registry = booted.moduleRef.get(PayableRegistry);
    registerPfxItems(registry, PRICE, delivered, new Set());
    const holds = booted.moduleRef.get(WalletHoldService);
    const earnings = booted.moduleRef.get(EarningSettlementService);
    const fxAccounts = provider.fx!;

    // ---- the people
    const accountsArea = new NuvionAccountsArea(client);
    async function naira(
      entity: string,
      account: string,
      user: string,
      byBan = false,
    ) {
      const details = await accountsArea.findAccountDetails(entity, account);
      const acct = await client.get<unknown>(
        { name: 'naira account', call: 'read' },
        `/accounts/${account}`,
        { entity_id: entity },
      );
      const a = acct.data as {
        account?: { nuvion_ban?: string };
        nuvion_ban?: string;
      };
      const ban = (a.account ?? a).nuvion_ban ?? null;
      if (!details?.accountNumber || !ban)
        throw new Error('a dev naira account has no number');
      // Dev gives different test entities the same receiving number; the routing number is unique.
      const number = byBan ? ban : details.accountNumber;
      await prisma.nuvionEntity.create({
        data: {
          wawuUserId: user,
          entityId: entity,
          accountId: account,
          nuvionBan: ban,
          accountNumber: number,
          status: 'approved',
          currency: 'NGN',
        },
      });
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: user,
          customerId: entity,
          walletId: `${entity}:${account}`,
          accountNumber: number,
          provider: 'nuvion',
        },
      });
    }
    const world = randomUUID();
    const nairaUser = randomUUID();
    users.push(world, nairaUser);
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: world,
        state: 'open',
        bvnHash: `hash-${world}`,
        bvnVerifiedAt: new Date(),
        phone: `+1${String(Date.now()).slice(-10)}`,
        provider: 'nuvion',
        worldCountry: 'US',
        worldFirstCurrency: 'USD',
        worldAccountOpenedAt: new Date(),
      },
    });
    await prisma.nuvionEntity.create({
      data: { wawuUserId: world, entityId: buyerEntity, status: 'approved' },
    });
    await prisma.fxAccount.create({
      data: {
        wawuUserId: world,
        provider: 'nuvion',
        currency: 'USD',
        chain: '',
        providerCustomerId: buyerEntity,
        providerAccountId: buyerUsd,
        ban: buyerBan,
        status: 'open',
      },
    });
    await naira(nairaEntity, nairaAccount, nairaUser);
    // The payee is a creator with a naira wallet: their 85% lands as for any sale.
    await naira(payeeEntity, payeeAccount, PFX_CREATOR.wawuUserId, true);
    users.push(PFX_CREATOR.wawuUserId);

    const authOf = async (id: string) => {
      const auth = `Bearer ${mintToken(id)}`;
      const set = await request(app.getHttpServer() as App)
        .post('/api/hub/money/pin')
        .set('Authorization', auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      if (set.status !== 201) throw new Error(`PIN not set (${set.status})`);
      return auth;
    };
    const worldAuth = await authOf(world);
    const nairaAuth = await authOf(nairaUser);
    const quote = async (auth: string, kind: string, extra = '') => {
      const res = await request(app.getHttpServer() as App)
        .get(
          `/api/hub/money/payments/quote?kind=${kind}&targetId=n-${randomUUID()}${extra}`,
        )
        .set('Authorization', auth);
      return {
        status: res.status,
        q: (res.body as { data: PaymentQuoteView }).data,
      };
    };
    const pay = async (
      auth: string,
      q: PaymentQuoteView,
      currency?: string,
    ) => {
      const res = await request(app.getHttpServer() as App)
        .post('/api/hub/money/payments')
        .set('Authorization', auth)
        .set('Idempotency-Key', randomUUID())
        .set('X-Transaction-Pin', PIN)
        .send({
          kind: q.kind,
          targetId: q.targetId,
          expectedTotalKobo: q.totalKobo,
          quoteToken: q.quoteToken,
          ...(currency ? { sourceCurrency: currency } : {}),
        });
      return {
        status: res.status,
        body: res.body as { data: PaymentView; reason?: unknown },
      };
    };
    const usdOf = async () =>
      (
        await fxAccounts.readAccount(
          { customerId: buyerEntity, walletId: '' },
          buyerUsd,
        )
      ).availableMinor;
    const opKobo = async () =>
      (await provider.getPlatformAccount()).availableKobo;
    const nairaOf = async () =>
      (
        await provider.getBalance({
          walletId: `${nairaEntity}:${nairaAccount}`,
        })
      ).availableKobo;

    const collectorUsd = async () => {
      if (!feeAccount) return 0n;
      const a = await client.get<unknown>(
        { name: 'collector account', call: 'read' },
        `/accounts/${feeAccount}`,
      );
      const d = a.data as { account?: { balance?: { available?: number } } };
      return BigInt(d.account?.balance?.available ?? 0);
    };
    const collector0 = await collectorUsd();
    // The earnings sweep takes sales from its start on: fix the start now.
    await earnings.sweepStart();

    // ---- 1. the dollar buyer: quote, pay, naira lands
    const usd0 = await usdOf();
    const op0 = await opKobo();
    const qd = await quote(worldAuth, 'content_unlock', '&sourceCurrency=USD');
    row(
      'quote: naira price against a dollar account, firm, with its expiry',
      qd.status === 200 &&
        qd.q.priceKobo === PRICE &&
        qd.q.totalKobo === PRICE &&
        !!qd.q.source &&
        qd.q.source.currency === 'USD' &&
        qd.q.source.amountMinor > 0,
      `price ${qd.q.priceKobo} kobo, source ${JSON.stringify({ ...qd.q.source, rate: qd.q.source?.rate })}`,
    );
    row(
      'quote: WAWU conversion fee is shown (0 unless set) and counted in the total',
      qd.q.source?.wawuFeeMinor === feeMinor &&
        qd.q.source?.totalMinor === qd.q.source.amountMinor + feeMinor,
      `fee ${qd.q.source?.wawuFeeMinor}, total ${qd.q.source?.totalMinor} cents`,
    );
    const paid = await pay(worldAuth, qd.q, 'USD');
    const pv = paid.body.data;
    const usd1 = await usdOf();
    const op1 = await opKobo();
    row(
      'pay: the payment completes and is delivered',
      paid.status === 201 && pv.status === 'completed' && pv.delivered === true,
      `status ${pv?.status}, delivered ${pv?.delivered}, source ${JSON.stringify(pv?.source)}`,
    );
    row(
      "the dollar account paid the firm amount and WAWU's naira account received exactly the price",
      usd0 - usd1 === BigInt(qd.q.source!.totalMinor) &&
        op1 - op0 === BigInt(PRICE),
      `USD cents ${usd0} -> ${usd1} (${usd0 - usd1}); WAWU naira ${op0} -> ${op1} (+${op1 - op0} kobo)`,
    );
    const prow = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: pv.id },
      include: { fx: true },
    });
    row(
      'the record: naira price, 85/15 split, the conversion kept',
      prow.priceKobo === BigInt(PRICE) &&
        prow.payeeShareKobo === 25_500n &&
        prow.wawuShareKobo === 4_500n &&
        prow.fx?.sourceAmountMinor === BigInt(qd.q.source!.amountMinor),
      `fee in ${prow.fx?.providerFeeMinor ?? 0n} provider, ${prow.fx?.wawuFeeMinor} WAWU (cents); transfer ${tail(prow.fx?.providerTransferId)}`,
    );

    if (feeMinor > 0) {
      const feeRow = await prisma.walletPaymentFx.findUniqueOrThrow({
        where: { paymentId: pv.id },
      });
      const collector1 = await collectorUsd();
      row(
        "WAWU's fee was charged and collected once",
        feeRow.feeLeg === 'done' &&
          collector1 - collector0 === BigInt(feeMinor),
        `feeLeg ${feeRow.feeLeg}; WAWU dollar account ${collector0} -> ${collector1} cents (+${collector1 - collector0})`,
      );
    }

    // ---- 2. the payee is credited as for any sale
    const payeeBefore = (
      await provider.getBalance({ walletId: `${payeeEntity}:${payeeAccount}` })
    ).availableKobo;
    const swept = await earnings.sweep(new Date());
    const earn = await prisma.earningSettlement.findFirst({
      where: { paymentId: pv.id },
    });
    const payeeAfter = (
      await provider.getBalance({ walletId: `${payeeEntity}:${payeeAccount}` })
    ).availableKobo;
    row(
      "the payee's 85% is owed as for any sale (and lands in the day's move)",
      earn?.amountKobo === 25_500n,
      `earning ${earn?.amountKobo} kobo, status ${earn?.status}; sweep ${JSON.stringify(swept)}; payee naira ${payeeBefore} -> ${payeeAfter}`,
    );

    // ---- 3. a held ticket paid in dollars, then refunded to the dollar account
    const usd2 = await usdOf();
    const op2 = await opKobo();
    const qt = await quote(worldAuth, 'event_ticket', '&sourceCurrency=USD');
    const pt = await pay(worldAuth, qt.q, 'USD');
    const tv = pt.body.data;
    const usd3 = await usdOf();
    row(
      'a ticket paid in dollars is held',
      pt.status === 201 &&
        tv.status === 'completed' &&
        tv.hold?.status === 'held',
      `status ${tv?.status}, hold ${tv?.hold?.status}, USD cents ${usd2} -> ${usd3}`,
    );
    const opHeld = await opKobo();
    const settled = await holds.refund(
      { paymentId: tv.id },
      'PAY-FX dev proof',
      { returnCharge: true },
    );
    const usd4 = await usdOf();
    const op4 = await opKobo();
    const fxRow = await prisma.walletPaymentFx.findUniqueOrThrow({
      where: { paymentId: tv.id },
    });
    row(
      'the refund returns the source currency: the same cents, to the same account',
      settled.state === 'settled' && usd4 === usd2,
      `hold ${settled.state}; USD cents ${usd3} -> ${usd4} (back to ${usd2}); refund ${fxRow.refundMinor} cents`,
    );
    row(
      'what the reverse conversion cost WAWU on dev',
      fxRow.refundCostKobo !== null,
      `took in ${PRICE} kobo, paid out ${fxRow.refundCostKobo} kobo for ${fxRow.refundMinor} cents (difference ${(fxRow.refundCostKobo ?? 0n) - BigInt(PRICE)} kobo); WAWU naira ${opHeld} -> ${op4} (before the ticket ${op2})`,
    );

    // ---- 4. the naira way, unchanged
    const n0 = await nairaOf();
    const opN0 = await opKobo();
    const qn = await quote(nairaAuth, 'content_unlock');
    const pn = await pay(nairaAuth, qn.q);
    const nv = pn.body.data;
    const n1 = await nairaOf();
    const opN1 = await opKobo();
    row(
      'a naira buyer pays as before: no source, the wallet is debited the quote total',
      qn.status === 200 &&
        !qn.q.source &&
        pn.status === 201 &&
        nv.status === 'completed' &&
        !nv.source &&
        n0 - n1 === BigInt(qn.q.totalKobo) &&
        opN1 - opN0 === BigInt(PRICE),
      `total ${qn.q.totalKobo}; naira ${n0} -> ${n1}; WAWU naira +${opN1 - opN0}`,
    );
    const failed = rows.filter((r) => !r[1]);
    console.log(
      failed.length === 0
        ? `ALL ${rows.length} PASSED`
        : `${failed.length} FAILED of ${rows.length}`,
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    const ids = (
      await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { id: true },
      })
    ).map((r) => r.id);
    await prisma.earningSettlement
      .deleteMany({ where: { paymentId: { in: ids } } })
      .catch(() => undefined);
    await prisma.walletPaymentFx
      .deleteMany({ where: { paymentId: { in: ids } } })
      .catch(() => undefined);
    await prisma.walletHold
      .deleteMany({ where: { paymentId: { in: ids } } })
      .catch(() => undefined);
    await prisma.fintavaLedgerEntry
      .deleteMany({ where: { paymentId: { in: ids } } })
      .catch(() => undefined);
    await prisma.walletPayment
      .deleteMany({ where: { id: { in: ids } } })
      .catch(() => undefined);
    await booted.app.close().catch(() => undefined);
    booted.restoreEnv();
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message.slice(0, 400) : 'failed');
    process.exit(1);
  },
);
