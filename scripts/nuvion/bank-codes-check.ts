/**
 * NUV-01's (key) check: `GET /bank-codes/NG` through the Nuvion client,
 * against Nuvion's SANDBOX only.
 *
 *   NUVION_API_KEY="$(sed -n 's/^NUVION_API_KEY=//p' <your env file>)" \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/bank-codes-check.ts
 *
 * Run it only when a lead brief allows api.nuvion.dev. It refuses any base
 * URL but https://api.nuvion.dev, sends one read, creates nothing and moves
 * nothing. The key is read from the environment and never printed; the
 * output is the HTTP outcome, Nuvion's request id and the bank list's size
 * and first names. Exit 0 only on a 200 with a non-empty list.
 */
import 'reflect-metadata';
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
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const client = new NuvionClient(settings, apiKey);
  try {
    const answer = await client.get<
      Array<{ bank_code?: string; bank_name?: string }>
    >({ name: 'bank codes NG', call: 'read' }, '/bank-codes/NG');
    const banks = Array.isArray(answer.data) ? answer.data : [];
    console.log(
      `HTTP ${answer.httpStatus}, request ${answer.requestId ?? '-'}: ${banks.length} banks; first: ${banks
        .slice(0, 3)
        .map((b) => `${b.bank_code ?? '?'} ${b.bank_name ?? '?'}`)
        .join(', ')}`,
    );
    return banks.length > 0 ? 0 : 1;
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
