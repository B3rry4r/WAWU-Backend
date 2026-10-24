/**
 * WALLET-21's (key) check: foreign accounts through the Nuvion adapter's `fx`
 * port, against Nuvion's DEV environment only.
 *
 *   NUVION_API_KEY=... FX_CHECK_ENTITY=<entity id> FX_CHECK_NGN_ACCOUNT=<its naira account id> \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/fx-dev-check.ts
 *
 * Run it only when a lead brief allows api.nuvion.dev. It refuses any base URL
 * but https://api.nuvion.dev. It opens a EUR and a USDT account on the entity,
 * quotes and swaps a small amount of naira to dollars and a few cents back,
 * asks for a stablecoin send of the smallest allowed amount, and reads a
 * statement. Dev money only. The key is read from the environment and never
 * printed; account numbers and addresses are printed as their last four.
 */
import 'reflect-metadata';
import { NuvionFxArea } from '../../src/nuvion/areas/fx';
import { NuvionClient } from '../../src/nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../src/nuvion/nuvion-config';
import { WalletProviderError } from '../../src/wallet-provider/wallet-provider-error';

const tail = (v: string | null | undefined) => (v ? `...${v.slice(-4)}` : null);
const say = (label: string, v: unknown) =>
  console.log(
    `${label}: ${JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x))}`,
  );

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
  const entity = env.FX_CHECK_ENTITY;
  const ngn = env.FX_CHECK_NGN_ACCOUNT;
  if (!entity || !ngn) {
    console.error(
      'Refused: FX_CHECK_ENTITY and FX_CHECK_NGN_ACCOUNT are needed.',
    );
    return 2;
  }
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const area = new NuvionFxArea(new NuvionClient(settings, apiKey));
  const person = { customerId: entity, walletId: `${entity}:${ngn}` };
  const stamp = Date.now().toString(36);
  let failures = 0;
  const step = async <T>(
    label: string,
    run: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      failures += 1;
      if (e instanceof WalletProviderError) {
        say(label, {
          refused: e.kind,
          http: e.httpStatus,
          words: e.messages.slice(0, 1),
        });
      } else {
        say(label, { error: e instanceof Error ? e.name : 'error' });
      }
      return null;
    }
  };

  const eur = await step('open EUR', () =>
    area.openAccount({
      person,
      currency: 'EUR',
      chain: null,
      displayName: `WAWU EUR check ${stamp}`,
      holderName: 'WAWU check',
    }),
  );
  if (eur)
    say('EUR', {
      id: tail(eur.account.accountId),
      balance: eur.account.availableMinor,
      details: eur.details && {
        status: eur.details.status,
        iban: tail(eur.details.iban),
        swift: tail(eur.details.swiftCode),
        bank: eur.details.bankName,
      },
    });
  const usdt = await step('open USDT eth', () =>
    area.openAccount({
      person,
      currency: 'USDT',
      chain: 'eth',
      displayName: `WAWU USDT check ${stamp}`,
      holderName: 'WAWU check',
    }),
  );
  if (usdt)
    say('USDT', {
      id: tail(usdt.account.accountId),
      details: usdt.details && {
        status: usdt.details.status,
        chain: usdt.details.chain,
        address: tail(usdt.details.address),
      },
    });
  const usd = await step('open USD', () =>
    area.openAccount({
      person,
      currency: 'USD',
      chain: null,
      displayName: `WAWU USD check ${stamp}`,
      holderName: 'WAWU check',
    }),
  );
  if (usd)
    say('USD', {
      id: tail(usd.account.accountId),
      details: usd.details && {
        status: usd.details.status,
        account: tail(usd.details.accountNumber),
        routing: tail(usd.details.routingNumber),
        swift: tail(usd.details.swiftCode),
        bank: usd.details.bankName,
      },
    });
  if (!usd || !usdt) return 1;

  const q = await step('quote NGN to USD', () =>
    area.quote({
      person,
      from: { currency: 'NGN', accountId: null },
      to: { currency: 'USD', accountId: usd.account.accountId },
      amountFromMinor: 50_000n,
    }),
  );
  if (q)
    say('quote', {
      from: q.amountFromMinor,
      to: q.amountToMinor,
      rate: q.rate,
      heldSeconds: Math.round((q.expiresAt.getTime() - Date.now()) / 1000),
      fee: q.feeMinor,
    });
  if (q) {
    const t = await step('swap NGN to USD', () =>
      area.swap({
        person,
        reference: `wawu-fx-check-${stamp}-a`,
        quoteId: q.id,
        from: { currency: 'NGN', accountId: null },
        to: {
          currency: 'USD',
          accountId: usd.account.accountId,
          ban: usd.account.ban,
        },
        amountFromMinor: q.amountFromMinor,
      }),
    );
    if (t) say('swap', { status: t.status, fee: t.feeMinor });
  }
  const back = await step('quote USD to NGN', () =>
    area.quote({
      person,
      from: { currency: 'USD', accountId: usd.account.accountId },
      to: { currency: 'NGN', accountId: null },
      amountFromMinor: 50n,
    }),
  );
  if (back) {
    const t = await step('swap USD to NGN', () =>
      area.swap({
        person,
        reference: `wawu-fx-check-${stamp}-b`,
        quoteId: back.id,
        from: { currency: 'USD', accountId: usd.account.accountId },
        to: { currency: 'NGN', accountId: null },
        amountFromMinor: back.amountFromMinor,
      }),
    );
    if (t)
      say('swap back', {
        status: t.status,
        fee: t.feeMinor,
        kobo: back.amountToMinor,
      });
  }
  const coin = await step('quote USD to USDT', () =>
    area.quote({
      person,
      from: { currency: 'USD', accountId: usd.account.accountId },
      to: { currency: 'USDT', accountId: usdt.account.accountId },
      amountFromMinor: 100n,
    }),
  );
  if (coin) {
    say('coin quote', {
      rate: coin.rate,
      heldSeconds: Math.round((coin.expiresAt.getTime() - Date.now()) / 1000),
    });
    const t = await step('swap USD to USDT', () =>
      area.swap({
        person,
        reference: `wawu-fx-check-${stamp}-c`,
        quoteId: coin.id,
        from: { currency: 'USD', accountId: usd.account.accountId },
        to: {
          currency: 'USDT',
          accountId: usdt.account.accountId,
          ban: usdt.account.ban,
        },
        amountFromMinor: coin.amountFromMinor,
      }),
    );
    if (t) say('swap to USDT', { status: t.status, fee: t.feeMinor });
  }
  const held = await step('read USDT', () =>
    area.readAccount(person, usdt.account.accountId),
  );
  if (held) say('USDT balance', { available: held.availableMinor });
  await step('send USDT', () =>
    area.send({
      person,
      reference: `wawu-fx-check-${stamp}-d`,
      accountId: usdt.account.accountId,
      currency: 'USDT',
      chain: 'eth',
      address: `0x${'ab'.repeat(20)}`,
      amountMinor: 100n,
      holderName: 'Outside wallet',
    }),
  );
  const now = new Date();
  const st = await step('statement USD', () =>
    area.statement(
      person,
      { accountId: usd.account.accountId, currency: 'USD' },
      {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        cursor: null,
        limit: 100,
      },
    ),
  );
  if (st)
    say(
      'statement',
      st.lines.map((l) => ({
        dir: l.direction,
        status: l.status,
        amount: l.amountMinor,
        fee: l.feeMinor,
        after: l.balanceAfterMinor,
        conversion:
          l.conversion &&
          `${l.conversion.fromCurrency}>${l.conversion.toCurrency}`,
      })),
    );
  return failures > 1 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
