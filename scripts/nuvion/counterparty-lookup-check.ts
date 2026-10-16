/**
 * NUV-06's (key) check: the account name check, `POST /counterparty-lookups`,
 * through the Nuvion client, against Nuvion's SANDBOX only (SANDBOX-FINDINGS
 * item 7: does it work with an API key for a test account, and what are the
 * names of the fields it answers).
 *
 *   NUVION_API_KEY="$(sed -n 's/^NUVION_API_KEY=//p' <your env file>)" \
 *   NUVION_CHECK_BANK_CODE=<a bank code from GET /bank-codes/NG> \
 *   NUVION_CHECK_ACCOUNT_NUMBER=<a ten-digit sandbox test account Nuvion names> \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/counterparty-lookup-check.ts
 *
 * Run it only when a lead brief allows api.nuvion.dev and
 * `GET https://api.nuvion.dev/bank-codes/NG` answers 200 with the key
 * (scripts/nuvion/bank-codes-check.ts). It refuses any base URL but
 * https://api.nuvion.dev, sends one bank list read and one lookup, creates
 * nothing and moves nothing. The key is read from the environment and never
 * printed; the output is the outcome the payouts area gives, the NAMES of the
 * fields Nuvion's answer carries (never their values), and the account
 * number's last four digits. Exit 0 only on a confirmed name.
 *
 * What it settles: whether the lookup answers for an API key, the real field
 * names (the area reads `account_holder_name`, `account_name` or
 * `holder_name`) and whether a body that names `country`, `account_number`
 * and `bank_code` is the one Nuvion takes. The stand-in the specs run
 * against guesses all three.
 */
import 'reflect-metadata';
import { NuvionPayoutsArea } from '../../src/nuvion/areas/payouts';
import { NuvionClient } from '../../src/nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../src/nuvion/nuvion-config';
import { NuvionError } from '../../src/nuvion/nuvion-error';

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
  const bankCode = (process.env.NUVION_CHECK_BANK_CODE ?? '').trim();
  const accountNumber = (process.env.NUVION_CHECK_ACCOUNT_NUMBER ?? '').trim();
  if (!bankCode || !/^\d{10}$/.test(accountNumber)) {
    console.error(
      'Set NUVION_CHECK_BANK_CODE and NUVION_CHECK_ACCOUNT_NUMBER (ten digits).',
    );
    return 2;
  }
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const client = new NuvionClient(settings, apiKey);
  const last4 = accountNumber.slice(-4);
  try {
    // The raw answer first: only the NAMES of its fields are printed.
    const raw = await client.post<unknown>(
      { name: 'counterparty lookup (raw)', call: 'check' },
      '/counterparty-lookups',
      { country: 'NG', account_number: accountNumber, bank_code: bankCode },
    );
    const keys =
      typeof raw.data === 'object' && raw.data !== null
        ? Object.keys(raw.data).join(', ')
        : typeof raw.data;
    console.log(
      `HTTP ${raw.httpStatus}, request ${raw.requestId ?? '-'}: fields [${keys}] for account ending ${last4}`,
    );
    const area = new NuvionPayoutsArea(client);
    const answer = await area.checkAccountName({ accountNumber, bankCode });
    console.log(
      `The payouts area reads it as: ${answer.outcome ?? '?'} (a name was ${answer.accountName ? 'found' : 'not found'})`,
    );
    return answer.matched ? 0 : 1;
  } catch (e) {
    if (e instanceof NuvionError) {
      console.error(
        `Failed: ${e.kind}, HTTP ${e.httpStatus ?? '-'}, ${e.nuvionType ?? 'no type'}, request ${e.requestId ?? '-'}`,
      );
      return 1;
    }
    throw e;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Failed: ${(e as Error).name}`);
    process.exit(1);
  },
);
