/**
 * WALLET-21 fix round 1 (verifier H1), against Nuvion's DEV only: WAWU's fee
 * on a swap out of naira, through the Hub's own services (the foreign-account
 * services over the real Nuvion adapter, the book area and a test database).
 *
 *   set -a; . <dev env file>; set +a
 *   DATABASE_URL=postgresql://...b18fx_hub_test... FX_CHECK_ENTITY=<entity id> \
 *   FX_CHECK_NGN_ACCOUNT=<its naira account id> \
 *     node dist/src/money/fx/fx-fee-dev-check-cli.js   (after `npx nest build`)
 *
 * FX_CHECK_KOBO (default 20000) is the naira swapped, in kobo.
 * Refuses any base URL but https://api.nuvion.dev. Sets a naira fee of 500
 * kobo, opens a USD account, swaps a small amount of naira to dollars and
 * prints what the operation says and what Nuvion's own record of the fee
 * transfer says. The key is never printed; account numbers print as their
 * last four. Dev money only.
 */
import 'reflect-metadata';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NuvionAccountsArea } from '../../nuvion/areas/accounts';
import { PrismaNuvionBookStore } from '../../nuvion/areas/book-store';
import { NuvionClient } from '../../nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../nuvion/nuvion-config';
import {
  nuvionAreas,
  NuvionWalletProvider,
} from '../../nuvion/nuvion-wallet-provider';
import { FxAccountsService } from './fx-accounts.service';
import { FxOperationsService } from './fx-operations.service';
import { FxPort } from './fx-provider';
import { FxSettings } from './fx-settings';

const tail = (v: string | null | undefined) => (v ? `...${v.slice(-4)}` : null);

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
  const entityId = env.FX_CHECK_ENTITY;
  const ngnAccountId = env.FX_CHECK_NGN_ACCOUNT;
  if (!entityId || !ngnAccountId || !/b18fx/.test(env.DATABASE_URL ?? '')) {
    console.error(
      'Refused: FX_CHECK_ENTITY, FX_CHECK_NGN_ACCOUNT and a b18fx test DATABASE_URL are needed.',
    );
    return 2;
  }
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const client = new NuvionClient(settings, apiKey);
  const prisma = new PrismaService();
  const user = 'b18fx-dev-fee';
  // Dev money only: a small amount (FX_CHECK_KOBO), 20,000 kobo by default.
  const kobo = Number(env.FX_CHECK_KOBO ?? '20000');
  const ledger: Array<{ kind: string; direction: string; kobo: number }> = [];
  try {
    const accountsArea = new NuvionAccountsArea(client);
    const details = await accountsArea.findAccountDetails(
      entityId,
      ngnAccountId,
    );
    const acct = await client.get<unknown>(
      { name: 'naira account', call: 'read' },
      `/accounts/${ngnAccountId}`,
      { entity_id: entityId },
    );
    const ban =
      (
        (acct.data as { account?: { nuvion_ban?: string } }).account ??
        (acct.data as { nuvion_ban?: string })
      ).nuvion_ban ?? null;
    const accountNumber = details?.accountNumber ?? null;
    if (!accountNumber || !ban) {
      console.error(
        'Refused: the dev naira account has no number or routing number.',
      );
      return 1;
    }
    await prisma.nuvionEntity.deleteMany({ where: { wawuUserId: user } });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: user,
        entityId,
        accountId: ngnAccountId,
        nuvionBan: ban,
        accountNumber,
        status: 'approved',
        currency: 'NGN',
      },
    });
    // The Hub finds a person's wallet by its row (the book area looks the sender up there).
    await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: user } });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: user,
        customerId: entityId,
        walletId: `${entityId}:${ngnAccountId}`,
        accountNumber,
        provider: 'nuvion',
      },
    });
    const provider = new NuvionWalletProvider(
      client,
      nuvionAreas(client, { bookStore: new PrismaNuvionBookStore(prisma) }),
    );
    const port = new FxPort(provider);
    const fxSettings = new FxSettings(
      { get: (k: string) => ({ FX_SWAP_FEE_NGN_MINOR: '500' })[k] } as never,
      { number: () => 1 } as never,
    );
    const accounts = new FxAccountsService(port, prisma, fxSettings);
    const keys = {
      attach: () => Promise.resolve(),
      finish: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const ledgerFake = {
      record: (r: {
        wallet: { kind: string };
        direction: string;
        amountKobo: number;
      }) => {
        ledger.push({
          kind: r.wallet.kind,
          direction: r.direction,
          kobo: r.amountKobo,
        });
        return Promise.resolve({
          entryId: 'x',
          created: true,
          discrepancy: null,
        });
      },
    };
    const ops = new FxOperationsService(
      port,
      prisma,
      fxSettings,
      accounts,
      keys as never,
      ledgerFake as never,
    );
    const wallet = {
      wawuUserId: user,
      customerId: entityId,
      walletId: `${entityId}:${ngnAccountId}`,
      accountNumber,
    };
    const before = await provider.getBalance({ walletId: wallet.walletId });
    const platform = await provider.getPlatformAccount();
    console.log(
      JSON.stringify({
        nairaBefore: String(before.availableKobo),
        platformBefore: String(platform.availableKobo),
        platform: tail(platform.accountNumber),
      }),
    );
    const usd = await accounts.open(wallet, { currency: 'USD' });
    const q = await ops.quote(wallet, {
      fromCurrency: 'NGN',
      toCurrency: 'USD',
      toAccountId: usd.id,
      amountFromMinor: kobo,
    });
    console.log(
      JSON.stringify({
        quote: {
          from: q.amountFromMinor,
          to: q.amountToMinor,
          wawuFee: q.wawuFeeMinor,
          total: q.totalFromMinor,
        },
      }),
    );
    const s = await ops.swap(
      wallet,
      {
        wawuUserId: user,
        method: 'POST',
        route: 'POST money/fx/swaps',
        key: `chk-${Date.now()}`,
        fingerprint: 'f',
      },
      { quoteId: q.id },
    );
    const op = await prisma.fxOperation.findUniqueOrThrow({
      where: { id: s.id },
    });
    const after = await provider.getBalance({ walletId: wallet.walletId });
    const platformAfter = await provider.getPlatformAccount();
    console.log(
      JSON.stringify({
        swap: s.status,
        feeLeg: op.feeLeg,
        wawuFeeMinor: s.wawuFeeMinor,
        nairaAfter: String(after.availableKobo),
        nairaMoved: String(before.availableKobo - after.availableKobo),
        platformMoved: String(
          platformAfter.availableKobo - platform.availableKobo,
        ),
        ledger,
      }),
    );
    const feeRef = `${op.reference}-fee`;
    const rec = await provider.findTransactionByReference(feeRef);
    console.log(
      JSON.stringify({
        feeRecord:
          rec.state === 'found'
            ? {
                status: rec.transaction.status,
                amountKobo: String(rec.transaction.amountKobo),
                feeKobo: String(rec.transaction.feeKobo ?? 0n),
              }
            : rec.state,
      }),
    );
    const ok =
      op.feeLeg === 'done' &&
      before.availableKobo - after.availableKobo === BigInt(kobo + 500) &&
      platformAfter.availableKobo - platform.availableKobo === 500n;
    console.log(
      ok
        ? 'FEE COLLECTED: payer debited the amount plus 500 kobo, WAWU credited 500 kobo'
        : 'FEE NOT COLLECTED AS EXPECTED',
    );
    return ok ? 0 : 1;
  } finally {
    await prisma.nuvionEntity
      .deleteMany({ where: { wawuUserId: user } })
      .catch(() => undefined);
    await prisma.fxOperation
      .deleteMany({ where: { wawuUserId: user } })
      .catch(() => undefined);
    await prisma.fxQuote
      .deleteMany({ where: { wawuUserId: user } })
      .catch(() => undefined);
    await prisma.fxAccount
      .deleteMany({ where: { wawuUserId: user } })
      .catch(() => undefined);
    await prisma.nuvionBookTransfer
      .deleteMany({ where: { fromEntityId: entityId } })
      .catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message.slice(0, 300) : 'failed');
    process.exit(1);
  },
);
