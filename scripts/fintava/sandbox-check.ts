/**
 * MONEY-06: the Fintava client, end to end against Fintava's SANDBOX.
 *
 *   FINTAVA_API_KEY="$(sed -n 's/^FINTAVA_API_KEY=//p' <your env file>)" \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/fintava/sandbox-check.ts
 *
 * Only https://dev.fintavapay.com is called (the script refuses any other
 * FINTAVA_BASE_URL). It uses the two OPS-02 test customers and creates none.
 * It runs no charged call (BVN, selfie, phone). Money moves are ₦10
 * wallet-to-wallet between WAWU's merchant wallet and the test customers,
 * and every one is sent back, so the balances end where they started. Bank
 * sends and bill purchases are not run: the sandbox refuses every payout
 * ("Unable to find customers", question 17 in the mobile repo's
 * docs/fintava/naira-api.md).
 *
 * The key is read from the environment and never printed. Output names
 * customers by their test names, keeps sandbox account numbers, and masks
 * anything else that is personal.
 */
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { FintavaClient } from '../../src/fintava/fintava-client';
import { FintavaError } from '../../src/fintava/fintava-error';
import { FINTAVA_SANDBOX_BASE_URL } from '../../src/fintava/fintava-config';
import { decideFintavaRetry } from '../../src/fintava/fintava-reconcile';
import type {
  FintavaSender,
  FintavaWalletTransferInput,
} from '../../src/fintava/fintava.interface';

const A = {
  name: 'A',
  customerId: '4e8409cf-1234-40f7-963a-5c212c7a9836',
  walletId: '3b84eae9-f1d5-4c7f-b5b7-7dfc52185cf7',
  accountNumber: '1154079370',
};
const B = {
  name: 'B',
  customerId: '3c672d13-cc4f-4200-bf13-038f21aab06a',
  walletId: 'bd656a80-6984-4832-9a06-a858f249aec6',
  accountNumber: '1151496137',
};
const TEN_NAIRA = 1000;
/**
 * Longer than the money timeout plus the resend safety window set below
 * (10 s + 60 s, the smallest window config allows), so a 404 can count.
 */
const RETRY_AFTER_MS = 71_000;

/** A step that could not run, with the reason. */
class NotRun extends Error {}

type Row = {
  step: string;
  result: 'PASS' | 'FAIL' | 'NOT RUN';
  detail: string;
};
const rows: Row[] = [];
let calls = 0;

function config(values: Record<string, string>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function client(key: string, moneyTimeoutMs = '10000'): FintavaClient {
  return new FintavaClient(
    config({
      FINTAVA_BASE_URL: FINTAVA_SANDBOX_BASE_URL,
      FINTAVA_API_KEY: key,
      FINTAVA_MONEY_TIMEOUT_MS: moneyTimeoutMs,
      FINTAVA_RESEND_SAFETY_MS: '60000',
    }),
  );
}

async function step(
  name: string,
  callsMade: number,
  run: () => Promise<string>,
): Promise<void> {
  calls += callsMade;
  try {
    rows.push({ step: name, result: 'PASS', detail: await run() });
  } catch (e) {
    if (e instanceof NotRun) {
      rows.push({ step: name, result: 'NOT RUN', detail: e.message });
      return;
    }
    const detail =
      e instanceof FintavaError
        ? `${e.kind} HTTP ${e.httpStatus} ${e.messages.join('; ')}`
        : e instanceof Error
          ? e.message
          : String(e);
    rows.push({ step: name, result: 'FAIL', detail });
  }
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`expected ${what}`);
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    if (e instanceof FintavaError) return e.kind;
    throw e;
  }
}

const naira = (kobo: number) => `₦${(kobo / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const base = process.env.FINTAVA_BASE_URL;
  if (base && base.replace(/\/+$/, '') !== FINTAVA_SANDBOX_BASE_URL) {
    throw new Error('This script only calls the Fintava sandbox.');
  }
  const key = (process.env.FINTAVA_API_KEY ?? '').trim();
  if (key === '') throw new Error('Set FINTAVA_API_KEY (the sandbox key).');
  const c = client(key);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ref = (n: number) => `MONEY06-SBX-${stamp}-${n}`;
  const started = new Date().toISOString();

  /** A ₦10 send. A lost answer is reconciled first, never resent blindly. */
  const sendSafely = async (
    input: FintavaWalletTransferInput,
    sender: FintavaSender,
  ): Promise<string> => {
    const attemptedAt = new Date();
    try {
      const r = await c.walletToWallet(input);
      return `accepted, sender after ${naira(r.sourceAvailableKobo ?? 0)}`;
    } catch (e) {
      if (!(e instanceof FintavaError) || e.kind !== 'outcome_unknown') throw e;
      await sleep(RETRY_AFTER_MS);
      const out = await c.retryWalletToWallet(input, { sender, attemptedAt });
      check(
        out.decision.action === 'settled' || out.receipt !== null,
        `settled or resent, not ${out.decision.action}`,
      );
      return `answer lost (${e.messages.join('; ')}); reconciled: ${out.decision.action}, ${out.receipt ? 'resent and accepted' : 'not resent'}`;
    }
  };

  let merchantAccount = '';
  let start = { merchant: 0, a: 0, b: 0 };

  await step('3. merchant balance (start)', 1, async () => {
    const m = await c.getMerchantBalance();
    merchantAccount = m.accountNumber;
    start.merchant = m.availableKobo;
    return `${m.accountName} ${m.accountNumber}, ${naira(m.availableKobo)} available, ${m.tier}`;
  });
  await step('3. wallet balances A and B (start)', 2, async () => {
    const [a, b] = await Promise.all([
      c.getWalletBalance(A.walletId),
      c.getWalletBalance(B.walletId),
    ]);
    start = { ...start, a: a.availableKobo, b: b.availableKobo };
    return `A ${naira(a.availableKobo)} ${a.tier}; B ${naira(b.availableKobo)} ${b.tier}`;
  });
  await step('5. bank list', 1, async () => {
    const banks = await c.listBanks();
    const loma = banks.find((b) => b.code === '090620');
    check(
      banks.length > 300 && loma !== undefined,
      'over 300 banks with Loma 090620',
    );
    return `${banks.length} banks (unique codes), Loma Bank ${loma?.code}`;
  });
  await step('6. name at another bank (sandbox stub)', 1, async () => {
    const n = await c.bankNameEnquiry('0123456789', '000013');
    check(n.matched, 'a match');
    return `matched ${n.matched}, ${n.accountName}, responseCode ${n.responseCode}`;
  });
  await step('6. name of a Fintava wallet, and of none', 2, async () => {
    const a = await c.walletNameEnquiry(A.accountNumber);
    const none = await c.walletNameEnquiry('1100000000');
    check(
      a?.accountName === 'Ada Sandbox' && none === null,
      'A named, unknown null',
    );
    return `A is "${a?.accountName}"; 1100000000 is null (the leaked-JS-error 400)`;
  });
  await step('2. customers A and B by id: four ids each', 2, async () => {
    const out: string[] = [];
    for (const x of [A, B]) {
      const cu = await c.getCustomer(x.customerId);
      check(
        cu.walletId === x.walletId && cu.accountNumber === x.accountNumber,
        'ids',
      );
      const ids = new Set([
        cu.customerId,
        cu.recordId,
        cu.walletId,
        cu.tagpayCustomerId,
      ]);
      check(ids.size === 4, 'four different ids');
      out.push(`${x.name}: ${cu.tier}, frozen ${cu.isFrozen}, 4 distinct ids`);
    }
    return out.join('; ');
  });
  await step('2. customer list', 1, async () => {
    const page = await c.listCustomers({ take: 10 });
    return `${page.itemCount} customers, first ${page.items[0]?.firstName} ${page.items[0]?.tier}`;
  });
  await step('4. customer history (A) and merchant history', 2, async () => {
    const h = await c.getCustomerHistory({
      customerId: A.customerId,
      take: 50,
    });
    const m = await c.getMerchantHistory({ take: 37 });
    check(
      h.items.every((t) => t.entry === 'DEBIT'),
      'A history debits only',
    );
    return `A: ${h.itemCount} rows, all DEBIT; merchant: ${m.itemCount} rows (debits only)`;
  });

  // 10: WAWU to A, ₦10, then the reference quirks on that send.
  const w1 = ref(1);
  let txnId1 = '';
  let receipt1 = null as Awaited<
    ReturnType<FintavaClient['walletToWallet']>
  > | null;
  await step(`10. WAWU to A ₦10 (${w1})`, 1, async () => {
    receipt1 = await c.walletToWallet({
      senderAccountNumber: merchantAccount,
      receiverAccountNumber: A.accountNumber,
      amountKobo: TEN_NAIRA,
      customerReference: w1,
      narration: 'MONEY-06 sandbox check',
    });
    return `accepted: amount ${naira(receipt1.amountKobo)}, fee ${naira(receipt1.feeKobo)}, sender after ${naira(receipt1.sourceAvailableKobo ?? 0)}`;
  });
  await step(
    '8. lookups: ours found, response `reference` absent, response `customerReference` found',
    3,
    async () => {
      check(receipt1 !== null, 'the send above');
      const r = receipt1!;
      const ours = await c.getTransactionByReference(w1);
      const tagapay = await c.getTransactionByReference(r.tagapayTransRef);
      const fintavas = await c.getTransactionByReference(r.fintavaReference);
      // Any lookup may answer 200 `{}` (unknown): accepted here, recorded.
      check(ours.state !== 'absent', 'ours never absent');
      if (ours.state === 'found') {
        check(ours.transaction.status === 'SUCCESS', 'ours SUCCESS');
      }
      check(tagapay.state !== 'found', 'the response reference never found');
      check(fintavas.state !== 'absent', "Fintava's reference never absent");
      txnId1 =
        ours.state === 'found'
          ? ours.transaction.id
          : fintavas.state === 'found'
            ? fintavas.transaction.id
            : '';
      const said = (l: { state: string }) => l.state;
      return `ours: ${said(ours)}; response .reference: ${said(tagapay)}; response .customerReference: ${said(fintavas)}`;
    },
  );
  await step(
    '8. by id: the full record; its tagapayTransRef is the response .reference',
    1,
    async () => {
      let via = 'lookup';
      if (txnId1 === '') {
        // The lookups answered `{}`: find the row in WAWU's history instead.
        const rec = await c.reconcile(w1, { kind: 'merchant' });
        calls += 2;
        if (rec.state !== 'found') {
          throw new NotRun(
            `no transaction id: lookup and history said ${rec.state}`,
          );
        }
        txnId1 = rec.transaction.id;
        via = `reconcile (${rec.source}, ${rec.transaction.status})`;
      }
      const byId = await c.getTransactionById(txnId1);
      // A lookup can answer 200 `{}` at any time (seen in this run for
      // records of every status): that is `unknown`, a typed answer too.
      check(byId.state !== 'absent', 'not absent');
      if (byId.state !== 'found')
        return `id via ${via}; by id: unknown (200 \`{}\`)`;
      const t = byId.transaction;
      check(t.tagapayTransRef === receipt1?.tagapayTransRef, 'the swap');
      return `id via ${via}; found, tagapayTransRef matches, fees platform ${t.platformCommKobo} merchant ${t.merchantCommKobo} loma ${t.lomaChargeKobo}`;
    },
  );
  await step(
    '8. unknown id: absent (200 data null) or unknown (200 `{}`), never found',
    1,
    async () => {
      const l = await c.getTransactionById(
        '00000000-0000-0000-0000-000000000000',
      );
      check(l.state !== 'found', 'not found');
      return l.state;
    },
  );
  await step(
    '9. the same request again: refused, nothing moved',
    2,
    async () => {
      const kind = await kindOf(
        c.walletToWallet({
          senderAccountNumber: merchantAccount,
          receiverAccountNumber: A.accountNumber,
          amountKobo: TEN_NAIRA,
          customerReference: w1,
        }),
      );
      check(kind === 'duplicate_reference', 'duplicate_reference');
      const a = await c.getWalletBalance(A.walletId);
      check(a.availableKobo === start.a + TEN_NAIRA, 'A up by ₦10 once');
      return `${kind}; A ${naira(a.availableKobo)} (start + ₦10 once)`;
    },
  );
  await step(
    'reconcile + retry of a settled send: settled, nothing sent',
    1,
    async () => {
      const out = await c.retryWalletToWallet(
        {
          senderAccountNumber: merchantAccount,
          receiverAccountNumber: A.accountNumber,
          amountKobo: TEN_NAIRA,
          customerReference: w1,
        },
        {
          sender: { kind: 'merchant' },
          attemptedAt: new Date(Date.now() - 60_000),
        },
      );
      check(
        out.decision.action === 'settled' && out.receipt === null,
        'settled',
      );
      return `decision ${out.decision.action}, nothing sent`;
    },
  );
  await step(`10. A to WAWU ₦10 (${ref(2)})`, 1, () =>
    sendSafely(
      {
        senderAccountNumber: A.accountNumber,
        receiverAccountNumber: merchantAccount,
        amountKobo: TEN_NAIRA,
        customerReference: ref(2),
        narration: 'MONEY-06 sandbox check back',
      },
      { kind: 'customer', customerId: A.customerId },
    ),
  );

  // 12: freeze B; a send to frozen B is refused and leaves its reference
  // usable; after unfreezing, the safe retry sends it under the same one.
  const w3 = ref(3);
  const frozenAttempt = new Date();
  await step('12. freeze B', 1, async () => {
    const w = await c.freezeWallet(B.walletId, 'MONEY-06 sandbox check');
    check(w.isFrozen, 'frozen');
    return `isFrozen ${w.isFrozen}, status ${w.walletStatus}`;
  });
  await step(
    `12. WAWU to frozen B ₦10 (${w3}): refused; balance still readable`,
    2,
    async () => {
      const kind = await kindOf(
        c.walletToWallet({
          senderAccountNumber: merchantAccount,
          receiverAccountNumber: B.accountNumber,
          amountKobo: TEN_NAIRA,
          customerReference: w3,
        }),
      );
      check(kind === 'wallet_inactive', 'wallet_inactive');
      const b = await c.getWalletBalance(B.walletId);
      check(b.availableKobo === start.b, 'B unchanged');
      return `${kind}; B ${naira(b.availableKobo)} unchanged`;
    },
  );
  await step('12. unfreeze B', 1, async () => {
    const w = await c.unfreezeWallet(B.walletId);
    check(!w.isFrozen, 'unfrozen');
    return `isFrozen ${w.isFrozen}`;
  });
  await sleep(RETRY_AFTER_MS);
  let bPaid = false;
  await step(
    `retry of the refused send (${w3}): reconcile, then resend only if Fintava has none`,
    2,
    async () => {
      const out = await c.retryWalletToWallet(
        {
          senderAccountNumber: merchantAccount,
          receiverAccountNumber: B.accountNumber,
          amountKobo: TEN_NAIRA,
          customerReference: w3,
        },
        { sender: { kind: 'merchant' }, attemptedAt: frozenAttempt },
      );
      bPaid = out.receipt !== null;
      if (out.decision.action === 'wait') {
        // A `{}` lookup and no row in history: never resent.
        return `decision wait (${out.decision.why}): nothing sent`;
      }
      check(
        out.decision.action === 'resend_same_reference' && bPaid,
        'resent under the same reference',
      );
      return `lookup 404; decision ${out.decision.action}; accepted ${naira(out.receipt!.amountKobo)}`;
    },
  );
  await step(`9. B to WAWU ₦10 (${ref(4)})`, 1, async () => {
    if (!bPaid)
      throw new NotRun('B was not paid by the retry, so nothing to send back');
    return sendSafely(
      {
        senderAccountNumber: B.accountNumber,
        receiverAccountNumber: merchantAccount,
        amountKobo: TEN_NAIRA,
        customerReference: ref(4),
        narration: 'MONEY-06 sandbox check back',
      },
      { kind: 'customer', customerId: B.customerId },
    );
  });

  // The `{}` quirk, read-only: OPS-02's refused bank send.
  await step(
    '8. OPS02R-MT-001 (an OPS-02 refused bank send): never sent again',
    3,
    async () => {
      const l = await c.getTransactionByReference('OPS02R-MT-001');
      const rec = await c.reconcile('OPS02R-MT-001', { kind: 'merchant' });
      const decision = decideFintavaRetry('bank_transfer', rec, {
        attemptedAt: new Date('2026-10-02T09:41:37Z'),
        now: new Date(),
        resendAfterMs: 30_000 + 600_000,
      });
      if (l.state === 'found')
        check(l.transaction.status === 'PENDING', 'PENDING');
      check(decision.action === 'wait', 'wait');
      const how =
        rec.state === 'found'
          ? `${rec.source} ${rec.transaction.status}`
          : rec.state;
      return `lookup ${l.state}${l.state === 'found' ? ` ${l.transaction.status}` : ''}; reconcile ${how}; decision ${decision.action}`;
    },
  );

  await step(
    'auth: a wrong key without live_ (400) and with live_ (404)',
    2,
    async () => {
      const k1 = await kindOf(
        client('not_a_real_key_money06').getMerchantBalance(),
      );
      const k2 = await kindOf(
        client('live_not_a_real_key_money06').getMerchantBalance(),
      );
      check(k1 === 'auth' && k2 === 'auth', 'auth twice');
      return `${k1}, ${k2}`;
    },
  );

  await step(
    '11. bill lists: discos, MTN and 9mobile data, cable',
    5,
    async () => {
      const discos = await c.listDiscos();
      const mtn = await c.listDataBundles('MTN');
      const nine = await c.listDataBundles('9MOBILE');
      const providers = await c.listCableProviders();
      const gotv = await c.listCablePlans('GOTV');
      return `${discos.length} discos; MTN ${mtn.length} bundles; 9mobile (ETISALAT) ${nine.length}; cable ${providers.join('/')}; GOTV ${gotv.length} plans`;
    },
  );
  await step('11. meter preview, made-up meter: null (free)', 1, async () => {
    const p = await c.previewMeter({
      meterNumber: '1111111111111',
      disco: 'AEDC',
      planType: 'prepaid',
    });
    check(p === null, 'null');
    return 'null';
  });

  await step('3. balances at the end: back where they started', 3, async () => {
    const m = await c.getMerchantBalance();
    const a = await c.getWalletBalance(A.walletId);
    const b = await c.getWalletBalance(B.walletId);
    check(
      m.availableKobo === start.merchant &&
        a.availableKobo === start.a &&
        b.availableKobo === start.b,
      'start balances',
    );
    return `WAWU ${naira(m.availableKobo)}, A ${naira(a.availableKobo)}, B ${naira(b.availableKobo)}`;
  });

  for (const [s, why] of [
    [
      '1. verify BVN, BVN selfie, phone',
      'charged calls: not allowed in this run',
    ],
    [
      '2. create customer, find by phone',
      'no new customers; the test phones are only on record masked',
    ],
    [
      '7. bank sends (customer and merchant)',
      'sandbox refuses every payout: question 17',
    ],
    [
      '11. bill purchases (electricity, airtime, data, cable)',
      'sandbox refuses every payout: question 17',
    ],
    ['13. webhooks', 'MONEY-07 receives them; no call to make'],
  ]) {
    rows.push({ step: s, result: 'NOT RUN', detail: why });
  }

  const ended = new Date().toISOString();
  console.log(
    `Fintava sandbox ${FINTAVA_SANDBOX_BASE_URL}, ${started} to ${ended}, about ${calls} calls`,
  );
  for (const r of rows)
    console.log(`| ${r.step} | ${r.result} | ${r.detail} |`);
  const failed = rows.filter((r) => r.result === 'FAIL').length;
  console.log(
    `${rows.filter((r) => r.result === 'PASS').length} passed, ${failed} failed, ${rows.filter((r) => r.result === 'NOT RUN').length} not run`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
