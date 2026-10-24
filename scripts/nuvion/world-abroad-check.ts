/**
 * WALLET-42's dev check: a send abroad debited from a FOREIGN-currency account of a person who has no naira account (a world
 * wallet, R-87), through the Hub's own Nuvion abroad area, against Nuvion's SANDBOX only.
 *
 *   set -a; . <your env file>; set +a        # NUVION_API_KEY and NUVION_OPERATIONAL_ACCOUNT_ID, never printed
 *   WORLD_ABROAD_ENTITY=<dev entity id with a GBP account and no naira account> \
 *   WORLD_ABROAD_ACCOUNT=<its GBP account id> \
 *   [WORLD_ABROAD_FEE_BAN=<routing number of WAWU's dev GBP account>]   # also takes GBP 0.10 as the fee and gives it back
 *   [WORLD_ABROAD_SEND=yes]                  # without it nothing is sent: sources, recipients and quotes only
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/world-abroad-check.ts
 *
 * Run it only when a lead brief allows api.nuvion.dev. It refuses any base URL but https://api.nuvion.dev. The holder it uses is
 * what the Hub hands the seam for a world wallet: the entity as the customer id and an EMPTY wallet id. It lists the sources
 * (expects the GBP account and no naira one), saves a Ghana mobile money recipient and a UK bank recipient, asks for a GBP to GHS
 * quote and, with WORLD_ABROAD_SEND=yes, makes one small conversion send and one same-currency send from the GBP account (dev
 * money), reading the balance before and after each, and what Nuvion charged. Ids and numbers are printed as their last four.
 */
import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { NuvionAbroadArea } from '../../src/nuvion/areas/abroad';
import { NuvionClient } from '../../src/nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../src/nuvion/nuvion-config';
import { AbroadRefusal } from '../../src/wallet-provider/abroad-provider';
import type {
  AbroadHolder,
  AbroadSource,
} from '../../src/wallet-provider/abroad-provider';

const rows: Array<[string, boolean, string]> = [];
const row = (name: string, ok: boolean, detail: string) => {
  rows.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};
const tail = (v: string | null | undefined) => (v ? `...${v.slice(-4)}` : '-');

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
  const entity = env.WORLD_ABROAD_ENTITY;
  const gbp = env.WORLD_ABROAD_ACCOUNT;
  if (!entity || !gbp) {
    console.error('Set WORLD_ABROAD_ENTITY and WORLD_ABROAD_ACCOUNT.');
    return 2;
  }
  const doSend = env.WORLD_ABROAD_SEND === 'yes';
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const area = new NuvionAbroadArea(new NuvionClient(settings, apiKey));
  // What the Hub's gate hands the seam for a world wallet: no naira wallet id.
  const holder: AbroadHolder = { customerId: entity, walletId: '' };

  const balance = async (): Promise<AbroadSource | undefined> =>
    (await area.sources(holder)).find((s) => s.currency === 'GBP');

  const sources = await area.sources(holder);
  const from = sources.find((s) => s.currency === 'GBP');
  row(
    'sources of a person with no naira account',
    Boolean(from) &&
      from?.accountRef === gbp &&
      !sources.some((s) => s.currency === 'NGN'),
    sources.map((s) => `${s.currency}:${s.availableMinor}`).join(' '),
  );
  if (!from) return 1;

  const phone = `+23324${String(randomInt(1_000_000, 9_999_999))}`;
  const momo = await area.saveRecipient({
    holder,
    country: 'GH',
    currency: 'GHS',
    method: 'mobile_money',
    scheme: 'mtn',
    holderName: 'Ama Mensah',
    fields: { phone_number: phone },
    marker: `w42-check-momo-${randomInt(1e9)}`,
  });
  row(
    'save recipient (GH mobile money) for a world holder',
    Boolean(momo.counterpartyId && momo.paymentDetailId),
    `counterparty ${tail(momo.counterpartyId)}, detail ${tail(momo.paymentDetailId)}`,
  );
  const uk = await area.saveRecipient({
    holder,
    country: 'GB',
    currency: 'GBP',
    method: 'bank',
    scheme: null,
    holderName: 'Ama Mensah',
    fields: {
      bank_name: 'Test Bank',
      sort_code: '040004',
      account_number: String(randomInt(10_000_000, 99_999_999)),
    },
    marker: `w42-check-uk-${randomInt(1e9)}`,
  });
  row(
    'save recipient (GB bank, FPS) for a world holder',
    Boolean(uk.counterpartyId && uk.paymentDetailId),
    `counterparty ${tail(uk.counterpartyId)}, detail ${tail(uk.paymentDetailId)}`,
  );

  const de = await area.saveRecipient({
    holder,
    country: 'DE',
    currency: 'EUR',
    method: 'bank',
    scheme: null,
    holderName: 'Ama Mensah',
    fields: { bank_name: 'Test Bank', iban: 'DE89370400440532013000' },
    marker: `w42-check-de-${randomInt(1e9)}`,
  });
  row(
    'save recipient (DE bank, SEPA) for a world holder',
    Boolean(de.counterpartyId && de.paymentDetailId),
    `counterparty ${tail(de.counterpartyId)}, detail ${tail(de.paymentDetailId)}`,
  );

  const quote = await area.quote({
    holder,
    fromCurrency: 'GBP',
    toCurrency: 'GHS',
    fromAccountRef: from.accountRef,
    amountMinor: 300,
    side: 'send',
  });
  row(
    'quote GBP to GHS from the GBP account',
    quote.quoteRef !== null && quote.amountToMinor > 0,
    `send ${quote.amountFromMinor} pence, they get ${quote.amountToMinor} pesewas, rate ${quote.rate}, held ${quote.validForSeconds} s`,
  );
  const same = await area.quote({
    holder,
    fromCurrency: 'GBP',
    toCurrency: 'GBP',
    fromAccountRef: from.accountRef,
    amountMinor: 100,
    side: 'send',
  });
  row('quote GBP to GBP (no Nuvion quote)', same.quoteRef === null, 'a hold');

  let emptyRefused = 'skipped';
  try {
    await area.quote({
      holder,
      fromCurrency: 'USD',
      toCurrency: 'GHS',
      fromAccountRef: gbp,
      amountMinor: 300,
      side: 'send',
    });
    emptyRefused = 'no refusal';
  } catch (e) {
    emptyRefused =
      e instanceof AbroadRefusal ? e.reason : `error ${(e as Error).name}`;
  }
  console.log(
    `INFO  quote USD to GHS on a GBP account id (no USD account): ${emptyRefused}`,
  );

  const collectorBan = env.WORLD_ABROAD_FEE_BAN;
  if (collectorBan) {
    // WAWU's fee out of the GBP account and back, as the Hub does around a send (GBP 0.10, dev money).
    const ref = `w42-check-fee-${randomInt(1e9)}`;
    const leg = {
      holder,
      currency: 'GBP',
      accountRef: from.accountRef,
      collectorBan,
    };
    const taken = await area.feeLeg({
      ...leg,
      direction: 'take',
      amountMinor: 10n,
      reference: ref,
      narration: 'WAWU fee',
    });
    const takenAgain = await area.feeLeg({
      ...leg,
      direction: 'take',
      amountMinor: 10n,
      reference: ref,
      narration: 'WAWU fee',
    });
    row(
      'WAWU fee taken from the GBP account, and a repeat of its reference changes nothing',
      taken.state === 'completed' && takenAgain.state === 'completed',
      `${taken.state}, repeat ${takenAgain.state}, fee ${taken.feeMinor}`,
    );
    const foundTake = await area.findFeeLeg({ ...leg, direction: 'take' }, ref);
    const back = await area.feeLeg({
      ...leg,
      direction: 'give_back',
      amountMinor: taken.amountMinor + taken.feeMinor,
      reference: `${ref}-back`,
      narration: 'WAWU fee given back',
    });
    const foundBack = await area.findFeeLeg(
      { ...leg, direction: 'give_back' },
      `${ref}-back`,
    );
    row(
      'WAWU fee given back from the collecting account, found again by reference',
      foundTake.state === 'found' &&
        back.state === 'completed' &&
        foundBack.state === 'found',
      `take ${foundTake.state}, give back ${back.state}, found ${foundBack.state}`,
    );
  }

  if (!doSend) {
    console.log('INFO  WORLD_ABROAD_SEND is not "yes": nothing was sent.');
    return rows.every((r) => r[1]) ? 0 : 1;
  }

  const before1 = await balance();
  const ref1 = `w42-check-${randomInt(1e9)}-a`;
  const sent1 = await area.send({
    holder,
    fromAccountRef: from.accountRef,
    fromCurrency: 'GBP',
    toCurrency: 'GHS',
    amountFromMinor: quote.amountFromMinor,
    counterpartyId: momo.counterpartyId,
    paymentDetailId: momo.paymentDetailId,
    method: 'mobile_money',
    quoteRef: quote.quoteRef,
    narration: 'WAWU transfer',
    reference: ref1,
  });
  const after1 = await balance();
  console.log(
    `INFO  send 1 (GBP to GHS): transfer ${tail(sent1.id)} ${sent1.providerStatus}/${sent1.providerReason}, currency ${sent1.currency}, amount ${sent1.amountMinor}, fee ${sent1.feeMinor}`,
  );
  const spent1 = (before1?.availableMinor ?? 0) - (after1?.availableMinor ?? 0);
  row(
    'the conversion send is debited from the GBP account',
    sent1.currency === 'GBP' && spent1 >= quote.amountFromMinor,
    `balance ${before1?.availableMinor} to ${after1?.availableMinor} (left the account: ${spent1}; amount ${quote.amountFromMinor}; the partner's fee ${sent1.feeMinor})`,
  );

  const before2 = await balance();
  const ref2 = `w42-check-${randomInt(1e9)}-b`;
  const sent2 = await area.send({
    holder,
    fromAccountRef: from.accountRef,
    fromCurrency: 'GBP',
    toCurrency: 'GBP',
    amountFromMinor: 100,
    counterpartyId: uk.counterpartyId,
    paymentDetailId: uk.paymentDetailId,
    method: 'bank',
    quoteRef: null,
    narration: 'WAWU transfer',
    reference: ref2,
  });
  const after2 = await balance();
  console.log(
    `INFO  send 2 (GBP to a UK bank, FPS): transfer ${tail(sent2.id)} ${sent2.providerStatus}/${sent2.providerReason}, currency ${sent2.currency}, amount ${sent2.amountMinor}, fee ${sent2.feeMinor}`,
  );
  const spent2 = (before2?.availableMinor ?? 0) - (after2?.availableMinor ?? 0);
  row(
    'the same-currency send is debited from the GBP account',
    sent2.currency === 'GBP' && spent2 >= 100,
    `balance ${before2?.availableMinor} to ${after2?.availableMinor} (left the account: ${spent2}; fee ${sent2.feeMinor})`,
  );

  // The third send needs room for the amount and a fee of up to GBP 4; with less in the account it is left out.
  if ((after2?.availableMinor ?? 0) >= 600) {
    const eurQuote = await area.quote({
      holder,
      fromCurrency: 'GBP',
      toCurrency: 'EUR',
      fromAccountRef: from.accountRef,
      amountMinor: 200,
      side: 'send',
    });
    const before3 = await balance();
    const sent3 = await area.send({
      holder,
      fromAccountRef: from.accountRef,
      fromCurrency: 'GBP',
      toCurrency: 'EUR',
      amountFromMinor: eurQuote.amountFromMinor,
      counterpartyId: de.counterpartyId,
      paymentDetailId: de.paymentDetailId,
      method: 'bank',
      quoteRef: eurQuote.quoteRef,
      narration: 'WAWU transfer',
      reference: `w42-check-${randomInt(1e9)}-c`,
    });
    const after3 = await balance();
    const spent3 =
      (before3?.availableMinor ?? 0) - (after3?.availableMinor ?? 0);
    console.log(
      `INFO  send 3 (GBP to a German bank, SEPA): transfer ${tail(sent3.id)} ${sent3.providerStatus}/${sent3.providerReason}, currency ${sent3.currency}, amount ${sent3.amountMinor}, fee ${sent3.feeMinor}`,
    );
    row(
      'the conversion bank send is debited from the GBP account',
      sent3.currency === 'GBP' && spent3 >= eurQuote.amountFromMinor,
      `balance ${before3?.availableMinor} to ${after3?.availableMinor} (left the account: ${spent3}; amount ${eurQuote.amountFromMinor}; fee ${sent3.feeMinor})`,
    );
  }

  const read = await area.read(holder, sent1.id);
  row(
    'read the send back with the holder of a world wallet',
    read.id === sent1.id,
    `${read.providerStatus}, fee ${read.feeMinor}`,
  );
  const found = await area.findByReference(holder, ref1, new Date());
  row(
    'find the send again by its reference',
    found.state === 'found',
    found.state,
  );

  return rows.every((r) => r[1]) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(
      `check failed: ${e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : 'unknown'}`,
    );
    process.exit(1);
  });
