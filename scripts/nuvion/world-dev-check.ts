/**
 * WALLET-41's (key) check: a person OUTSIDE Nigeria opened through the Nuvion
 * adapter's own areas, against Nuvion's DEV environment only.
 *
 *   NUVION_API_KEY=... [NUVION_HOSTED_LIVENESS=on NUVION_LIVENESS_REDIRECT_ORIGINS=https://example.org] \
 *     WORLD_CHECK_COUNTRIES=US,GB,GH,DE,CA,AE,KE \
 *     npx ts-node --transpile-only \
 *       -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *       scripts/nuvion/world-dev-check.ts
 *
 * Run it only when a lead brief allows api.nuvion.dev. It refuses any base URL
 * but https://api.nuvion.dev. For each country it makes an individual entity
 * with NO BVN and NO NIN and that country's ID document (the review details
 * the Hub builds for a world opening), uploads the two documents, submits,
 * waits for the decision, then opens the first account in the currency the
 * Hub's table gives that country and asks for its receiving details. The key
 * is read from the environment and never printed; ids and numbers are printed
 * as their last four. Dev data only.
 */
import 'reflect-metadata';
import { NuvionFxArea } from '../../src/nuvion/areas/fx';
import { NuvionDocumentsArea } from '../../src/nuvion/areas/documents';
import { NuvionOpeningArea } from '../../src/nuvion/areas/opening';
import { NuvionClient } from '../../src/nuvion/nuvion-client';
import {
  NUVION_SANDBOX_BASE_URL,
  readNuvionSettings,
} from '../../src/nuvion/nuvion-config';
import { DEFAULT_FIRST_CURRENCY } from '../../src/money/world/world-countries';
import { WalletProviderError } from '../../src/wallet-provider/wallet-provider-error';

const tail = (v: string | null | undefined) => (v ? `...${v.slice(-4)}` : null);
const say = (label: string, v: unknown) =>
  console.log(
    `${label}: ${JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x))}`,
  );

/** A made-up resident for each country: a real-looking address, a number that is not a real one. */
const PEOPLE: Record<
  string,
  {
    line1: string;
    city: string;
    state: string;
    postal: string;
    phone: string;
    idType: 'international_passport' | 'drivers_license' | 'national_id';
  }
> = {
  US: {
    line1: '210 West 77th Street',
    city: 'New York',
    state: 'New York',
    postal: '10024',
    phone: '+12125550198',
    idType: 'international_passport',
  },
  GB: {
    line1: '221B Baker Street',
    city: 'London',
    state: 'England',
    postal: 'NW1 6XE',
    phone: '+442071234567',
    idType: 'drivers_license',
  },
  GH: {
    line1: '12 Ring Road',
    city: 'Accra',
    state: 'Greater Accra',
    postal: 'GA100',
    phone: '+233201234567',
    idType: 'national_id',
  },
  DE: {
    line1: 'Unter den Linden 1',
    city: 'Berlin',
    state: 'Berlin',
    postal: '10117',
    phone: '+4915112345678',
    idType: 'national_id',
  },
  CA: {
    line1: '100 Queen St',
    city: 'Toronto',
    state: 'Ontario',
    postal: 'M5H 2N2',
    phone: '+14165550123',
    idType: 'drivers_license',
  },
  AE: {
    line1: 'Sheikh Zayed Rd',
    city: 'Dubai',
    state: 'Dubai',
    postal: '00000',
    phone: '+971501234567',
    idType: 'international_passport',
  },
  KE: {
    line1: 'Moi Avenue 5',
    city: 'Nairobi',
    state: 'Nairobi',
    postal: '00100',
    phone: '+254712345678',
    idType: 'national_id',
  },
};

// A 1x1 PNG: dev takes any image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
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
  const { settings, apiKey } = readNuvionSettings((k) => env[k]);
  const client = new NuvionClient(settings, apiKey);
  const opening = new NuvionOpeningArea(client);
  const documents = new NuvionDocumentsArea(client);
  const fx = new NuvionFxArea(client);
  const countries = (env.WORLD_CHECK_COUNTRIES ?? 'US,GB,GH,DE,CA,AE,KE')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => PEOPLE[c]);
  let failures = 0;
  const stamp = Date.now().toString(36);
  for (const country of countries) {
    const p = PEOPLE[country];
    const currency = DEFAULT_FIRST_CURRENCY[country] ?? 'USD';
    const step = async <T>(label: string, run: () => Promise<T>) => {
      try {
        return await run();
      } catch (e) {
        failures += 1;
        if (e instanceof WalletProviderError) {
          say(`${country} ${label}`, {
            refused: e.kind,
            http: e.httpStatus,
            words: e.messages.slice(0, 2),
          });
        } else {
          say(`${country} ${label}`, {
            error: e instanceof Error ? e.name : 'error',
          });
        }
        return null;
      }
    };
    const made = await step('create entity (no BVN, no NIN)', () =>
      opening.openWallet({
        firstName: 'Wtest',
        lastName: `${country}${stamp}`.slice(0, 40).replace(/[0-9]/g, 'x'),
        phone: p.phone,
        email: `w41check+${country.toLowerCase()}${stamp}@example.com`,
        address: p.line1,
        dateOfBirth: '1990-04-12',
        bvn: '',
        nin: '',
        review: {
          middleName: null,
          gender: 'male',
          nationality: country,
          address: {
            line1: p.line1,
            line2: null,
            city: p.city,
            state: p.state,
            postalCode: p.postal,
            countryCode: country,
          },
          idDocument: {
            type: p.idType,
            number: `X1234567${country}`,
            issueDate: null,
            expiryDate: '2030-01-09',
            issuingCountry: country,
          },
          proofOfAddressType: 'utility_bill',
          world: true,
          customerId: null,
          numbersAgain: true,
          lostAttemptAt: null,
        },
      }),
    );
    if (!made || made.state !== 'provisioning' || !made.review?.personId)
      continue;
    const entityId = made.customerId;
    const personId = made.review.personId;
    say(`${country} entity`, {
      id: tail(entityId),
      status: made.review.status,
    });
    for (const kind of ['identity', 'proof_of_address'] as const) {
      await step(`upload ${kind}`, () =>
        documents.uploadDocument({
          entityId,
          personId,
          kind,
          front: PNG,
          back: null,
          mimeType: 'image/png',
        }),
      );
    }
    await step('submit', () => documents.submitOnboarding(entityId));
    let status = made.review.status;
    for (let i = 0; i < 8 && status !== 'approved'; i += 1) {
      await new Promise((r) => setTimeout(r, 4000));
      const read = await step('read entity', () =>
        opening.readEntity(entityId),
      );
      if (read) status = read.status;
    }
    say(`${country} review`, { status });
    if (documents.hostedLiveness) {
      const live = await step('start liveness', () =>
        documents.startLiveness(
          entityId,
          settings.livenessRedirectOrigins?.[0]
            ? `${settings.livenessRedirectOrigins[0]}/done`
            : null,
        ),
      );
      if (live)
        say(`${country} liveness`, {
          session: tail(live.sessionId),
          hostedPage: live.url.startsWith('https://'),
        });
    }
    if (status !== 'approved') continue;
    const person = { customerId: entityId, walletId: '' };
    const account = await step(`open ${currency}`, () =>
      fx.openAccount({
        person,
        currency: currency as 'USD',
        chain: null,
        displayName: `WAWU ${currency} world check ${stamp}`,
        holderName: 'WAWU check',
      }),
    );
    if (account) {
      say(`${country} ${currency}`, {
        id: tail(account.account.accountId),
        details: account.details && {
          status: account.details.status,
          account: tail(account.details.accountNumber),
          iban: tail(account.details.iban),
        },
      });
    }
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`check failed: ${e instanceof Error ? e.name : 'error'}`);
    process.exit(1);
  },
);
