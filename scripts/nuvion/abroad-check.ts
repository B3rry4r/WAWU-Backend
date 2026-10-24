/**
 * NUV-11's dev check: the send-abroad area against Nuvion's SANDBOX only.
 *
 *   NUVION_API_KEY="$(sed -n 's/^NUVION_API_KEY=//p' <your env file>)" \
 *   ABROAD_CHECK_ENTITY=<dev entity id> ABROAD_CHECK_NGN_ACCOUNT=<its naira account id> \
 *   ABROAD_CHECK_USD_ACCOUNT=<its dollar account id, empty is fine> \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/abroad-check.ts
 *
 * Run it only when a lead brief allows api.nuvion.dev. It refuses any base
 * URL but https://api.nuvion.dev. It reads the bank directory and the
 * accounts, makes two recipients (a mobile money wallet and a bank account in Ghana with
 * random numbers; dev keeps them), asks for quotes, and tries a send from an EMPTY
 * account, which Nuvion refuses: nothing moves. The key is read from the
 * environment and never printed. Exit 0 only when every row held.
 */
import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { NuvionAbroadArea } from '../../src/nuvion/areas/abroad';
import { nuvionWalletId } from '../../src/nuvion/areas/accounts';
import { NuvionClient } from '../../src/nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../src/nuvion/nuvion-config';
import { AbroadRefusal } from '../../src/wallet-provider/abroad-provider';

const rows: Array<[string, boolean, string]> = [];
const row = (name: string, ok: boolean, detail: string) => {
  rows.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no refusal';
  } catch (e) {
    return e instanceof AbroadRefusal ? e.reason : `error ${(e as Error).name}`;
  }
}

async function main(): Promise<number> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NUVION_BASE_URL: process.env.NUVION_BASE_URL || NUVION_SANDBOX_BASE_URL,
    NUVION_WEBHOOK_SECRET:
      process.env.NUVION_WEBHOOK_SECRET || 'unused-by-this-check',
    NUVION_OPERATIONAL_ACCOUNT_ID:
      process.env.NUVION_OPERATIONAL_ACCOUNT_ID || '01UNUSEDBYTHISCHECK0000000',
  };
  if (
    (env.NUVION_BASE_URL ?? '').replace(/\/+$/, '') !== NUVION_SANDBOX_BASE_URL
  ) {
    console.error(
      `Refused: this check runs against ${NUVION_SANDBOX_BASE_URL} only.`,
    );
    return 2;
  }
  const entity = env.ABROAD_CHECK_ENTITY;
  const ngn = env.ABROAD_CHECK_NGN_ACCOUNT;
  const usd = env.ABROAD_CHECK_USD_ACCOUNT;
  if (!entity || !ngn || !usd) {
    console.error(
      'Set ABROAD_CHECK_ENTITY, ABROAD_CHECK_NGN_ACCOUNT and ABROAD_CHECK_USD_ACCOUNT.',
    );
    return 2;
  }
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const area = new NuvionAbroadArea(new NuvionClient(settings, apiKey));
  const holder = { customerId: entity, walletId: nuvionWalletId(entity, ngn) };

  const banks = await area.banks('GH');
  row(
    'bank directory GH',
    banks.length > 10,
    `${banks.length} banks, first ${banks[0]?.name}`,
  );

  const sources = await area.sources(holder);
  row(
    'sources',
    sources.some((s) => s.currency === 'NGN') &&
      sources.some((s) => s.currency === 'USD'),
    sources.map((s) => `${s.currency}:${s.availableMinor}`).join(' '),
  );

  const phone = `+23324${String(randomInt(1_000_000, 9_999_999))}`;
  const saved = await area.saveRecipient({
    holder,
    country: 'GH',
    currency: 'GHS',
    method: 'mobile_money',
    scheme: 'mtn',
    holderName: 'Ama Mensah',
    fields: { phone_number: phone },
    marker: `b23-check-${randomInt(1e9)}`,
  });
  row(
    'save recipient (GH mobile money)',
    Boolean(saved.counterpartyId && saved.paymentDetailId),
    'counterparty and payment detail made',
  );
  // An account number is unique within a counterparty at Nuvion (dev: error_duplicate_resource),
  // so a bank account saved again after a lost answer (same marker, so the same counterparty) is adopted, never refused.
  const account = String(randomInt(1_000_000_000, 9_999_999_999));
  const bankInput = (marker: string) => ({
    holder,
    country: 'GH',
    currency: 'GHS',
    method: 'bank' as const,
    scheme: null,
    holderName: 'Ama Mensah',
    fields: { bank: banks[0].code, account_number: account },
    marker,
  });
  const marker = `b23-check-bank-${randomInt(1e9)}`;
  const bank1 = await area.saveRecipient(bankInput(marker));
  const bank2 = await area.saveRecipient(bankInput(marker));
  row(
    'a bank account saved again is adopted, not refused',
    bank2.paymentDetailId === bank1.paymentDetailId,
    'duplicate resolved to the first payment detail',
  );

  const q = await area.quote({
    holder,
    fromCurrency: 'USD',
    toCurrency: 'GHS',
    fromAccountRef: usd,
    amountMinor: 5000,
    side: 'send',
  });
  row(
    'quote USD to GHS',
    q.quoteRef !== null && q.amountToMinor > 0,
    `rate ${q.rate}, valid ${q.validForSeconds}s`,
  );
  const same = await area.quote({
    holder,
    fromCurrency: 'USD',
    toCurrency: 'USD',
    fromAccountRef: usd,
    amountMinor: 5000,
    side: 'send',
  });
  row('same currency needs no quote', same.quoteRef === null, 'held by WAWU');
  row(
    'quote NGN to GHS says plainly there is no rate',
    (await refusal(
      area.quote({
        holder,
        fromCurrency: 'NGN',
        toCurrency: 'GHS',
        fromAccountRef: ngn,
        amountMinor: 1_000_000,
        side: 'send',
      }),
    )) === 'rate_unavailable',
    'rate_unavailable (dev: HTTP 500 dependency unavailable)',
  );

  const sent = await refusal(
    area.send({
      holder,
      fromAccountRef: usd,
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      amountFromMinor: 5000,
      counterpartyId: saved.counterpartyId,
      paymentDetailId: saved.paymentDetailId,
      method: 'mobile_money',
      quoteRef: q.quoteRef,
      narration: 'b23 check',
      reference: `b23-check-${randomInt(1e12)}`,
    }),
  );
  row(
    'send from an empty account is refused, nothing moves',
    sent === 'insufficient_funds',
    sent,
  );

  return rows.every(([, ok]) => ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(
      `Failed: ${(e as Error).name} ${(e as Error).message.slice(0, 200)}`,
    );
    process.exit(1);
  },
);
