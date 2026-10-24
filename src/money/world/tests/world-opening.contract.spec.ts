import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { Client } from 'pg';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NuvionOpeningArea } from '../../../nuvion/areas/opening';
import type { NuvionClient } from '../../../nuvion/nuvion-client';
import type {
  ProviderOpenedWallet,
  ProviderOpenWalletInput,
  WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import { IdentityHasher } from '../../identity/identity-config';
import { MoneyError } from '../../money-error';
import { OpenNairaWalletDto } from '../../opening/dto/open-wallet.dto';
import {
  ReviewedOpening,
  type ReviewedOpeningHost,
} from '../../opening/reviewed-opening';

/**
 * WALLET-41 (R-87): the opening path for a person outside Nigeria, from the
 * body to the call the provider gets and the rows we keep, against a real
 * (test) database. The provider is a stand-in that records what it was sent;
 * the Nuvion adapter's own body is checked on its own at the end. The real
 * Nuvion DEV answers are in docs/nuvion/DEV-RESULTS.md (scripts/nuvion/
 * world-dev-check.ts).
 */

jest.setTimeout(60_000);

const HASH_KEY = 'wallet41-test-opening-hash-key-0123456789abcdef';

const US_BODY = {
  firstName: 'Alex',
  lastName: 'Johnson',
  dateOfBirth: '1990-04-12',
  address: '210 West 77th Street',
  gender: 'male',
  city: 'New York',
  state: 'New York',
  postalCode: '10024',
  idType: 'international_passport',
  idNumber: 'P123456789',
  proofOfAddressType: 'utility_bill',
  countryCode: 'US',
  firstCurrency: 'USD',
};

describe('WALLET-41: opening a wallet from outside Nigeria', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let opening: ReviewedOpening;
  let sent: ProviderOpenWalletInput[] = [];
  let mode: 'ok' | { refuse: string[] } = 'ok';
  const users: string[] = [];
  const phones: string[] = [];
  let seq = 0;

  const dto = (over: Record<string, unknown> = {}) =>
    plainToInstance(OpenNairaWalletDto, { ...US_BODY, ...over });

  const provider = {
    name: 'nuvion',
    configured: true,
    capabilities: { separateKyc: true },
    openWallet: (
      input: ProviderOpenWalletInput,
    ): Promise<ProviderOpenedWallet> => {
      sent.push(input);
      if (mode !== 'ok') {
        return Promise.reject(
          new WalletProviderError({
            kind: 'validation',
            provider: 'nuvion',
            operation: 'create individual entity',
            httpStatus: 422,
            messages: mode.refuse,
            recordMayExist: false,
          }),
        );
      }
      return Promise.resolve({
        state: 'provisioning',
        customerId:
          `01ENT${randomUUID().replace(/-/g, '').toUpperCase()}`.slice(0, 26),
        walletId: null,
        review: {
          personId:
            `01PER${randomUUID().replace(/-/g, '').toUpperCase()}`.slice(0, 26),
          status: 'incomplete',
          bvnStatus: null,
          ninStatus: null,
          documentStatus: null,
          addressProofStatus: null,
          identificationStatus: null,
          reasons: [],
          found: false,
          updated: null,
        },
      });
    },
  } as unknown as WalletProvider;

  let testDatabase = false;
  let hasher: IdentityHasher;

  /** A person, with a phone in the form their token would carry. */
  function who(phone?: string): { id: string; phone: string } {
    const id = randomUUID();
    users.push(id);
    seq += 1;
    const p = phone ?? `+1212555${String(1000 + seq).padStart(4, '0')}`;
    phones.push(p);
    return { id, phone: p };
  }

  const claims = (p: { phone: string }) => ({
    email: 'alex@example.com',
    phone: p.phone,
  });

  beforeAll(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const res = await client.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      testDatabase = /test/.test(res.rows[0].name);
    } finally {
      await client.end();
    }
    if (!testDatabase)
      throw new Error('This spec runs only on a test database.');
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ IDENTITY_HASH_KEY: HASH_KEY })],
        }),
        PrismaModule,
      ],
      providers: [IdentityHasher],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    hasher = new IdentityHasher(moduleRef.get(ConfigService));
    const host: ReviewedOpeningHost = {
      prisma,
      provider,
      hasher,
      dbNow: () => Promise.resolve(new Date()),
      opening: (id) =>
        prisma.fintavaWalletOpening.findUnique({
          where: { wawuUserId: id },
        }),
      unstick: (row) => Promise.resolve(row),
      hasWallet: async (id) =>
        (await prisma.fintavaWallet.findUnique({
          where: { wawuUserId: id },
        })) !== null,
      mayHaveOpened: () => false,
      refusal: () =>
        new MoneyError('account_not_opened', 'Check your details.'),
      unavailable: () => new MoneyError('provider_unreachable', 'Try again.'),
      resendAfterMs: () => 5_000,
      recheckAfterMs: 1_000,
    };
    opening = new ReviewedOpening(host);
  });

  beforeEach(() => {
    sent = [];
    mode = 'ok';
  });

  afterAll(async () => {
    if (testDatabase && users.length > 0) {
      await prisma.bvnCheckAttempt.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    await moduleRef?.close();
  });

  it('opens with no BVN and no NIN: the provider is sent the country’s ID and a world flag', async () => {
    const p = who();
    await opening.open(p.id, claims(p), dto(), null);
    expect(sent).toHaveLength(1);
    const call = sent[0];
    expect(call.bvn).toBe('');
    expect(call.nin).toBe('');
    expect(call.phone).toBe(p.phone);
    expect(call.review).toMatchObject({
      world: true,
      nationality: 'US',
      address: { countryCode: 'US', city: 'New York', postalCode: '10024' },
      idDocument: {
        type: 'international_passport',
        issuingCountry: 'US',
      },
      customerId: null,
    });
    const row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(row).toMatchObject({
      provider: 'nuvion',
      worldCountry: 'US',
      worldFirstCurrency: 'USD',
      state: 'review',
      phone: p.phone,
    });
    // The claim is the keyed identity of the document, never a BVN, and the
    // document number itself is nowhere.
    expect(row.bvnHash).toBe(hasher.hash('bvn', 'world:US:P123456789'));
    expect(JSON.stringify(row)).not.toContain('P123456789');
    const entity = await prisma.nuvionEntity.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(entity.status).toBe('incomplete');
  });

  it('a passport is issued by the nationality, a licence by the country of residence', async () => {
    const a = who();
    await opening.open(
      a.id,
      claims(a),
      dto({ nationality: 'GH', idNumber: 'G0000001' }),
      null,
    );
    expect(sent[0].review).toMatchObject({
      nationality: 'GH',
      address: { countryCode: 'US' },
      idDocument: { issuingCountry: 'GH' },
    });
    const b = who();
    await opening.open(
      b.id,
      claims(b),
      dto({
        nationality: 'GH',
        idType: 'drivers_license',
        idNumber: 'DL778899',
      }),
      null,
    );
    expect(sent[1].review).toMatchObject({
      nationality: 'GH',
      idDocument: { type: 'drivers_license', issuingCountry: 'US' },
    });
  });

  it('one ID document is one wallet: another account is told the same plain thing, and nothing is sent', async () => {
    const a = who();
    const b = who();
    await opening.open(a.id, claims(a), dto({ idNumber: 'SAME-DOC-1' }), null);
    await expect(
      opening.open(b.id, claims(b), dto({ idNumber: 'same doc 1' }), null),
    ).rejects.toMatchObject({ code: 'identity_has_wallet' });
    expect(sent).toHaveLength(1);
  });

  it('the same number sent as another kind of document is the same wallet', async () => {
    const a = who();
    const b = who();
    const c = who();
    await opening.open(
      a.id,
      claims(a),
      dto({ idNumber: 'ONE-NUMBER-77' }),
      null,
    );
    await expect(
      opening.open(
        b.id,
        claims(b),
        dto({ idNumber: 'one number 77', idType: 'national_id' }),
        null,
      ),
    ).rejects.toMatchObject({ code: 'identity_has_wallet' });
    await expect(
      opening.open(
        c.id,
        claims(c),
        dto({ idNumber: 'ONE-NUMBER-77', idType: 'drivers_license' }),
        null,
      ),
    ).rejects.toMatchObject({ code: 'identity_has_wallet' });
    expect(sent).toHaveLength(1);
  });

  it('the same passport from two accounts that live in different countries is one wallet: the second gets identity_has_wallet and nothing is sent', async () => {
    // The key follows the DOCUMENT (the passport's nationality), not where
    // the account says it lives. A second account in another country, a
    // different case and dashes, even a licence type: still the first's.
    const a = who();
    const b = who();
    const c = who();
    await opening.open(
      a.id,
      claims(a),
      dto({
        countryCode: 'US',
        nationality: 'GB',
        idNumber: 'GBR-PASS-4455',
      }),
      null,
    );
    await expect(
      opening.open(
        b.id,
        claims(b),
        dto({
          countryCode: 'DE',
          firstCurrency: 'EUR',
          nationality: 'GB',
          idNumber: 'gbr pass 4455',
        }),
        null,
      ),
    ).rejects.toMatchObject({ code: 'identity_has_wallet' });
    await expect(
      opening.open(
        c.id,
        claims(c),
        dto({
          countryCode: 'GB',
          firstCurrency: 'GBP',
          idNumber: 'GBR-PASS-4455',
        }),
        null,
      ),
    ).rejects.toMatchObject({ code: 'identity_has_wallet' });
    expect(sent).toHaveLength(1);
    const rows = await prisma.fintavaWalletOpening.findMany({
      where: { wawuUserId: { in: [b.id, c.id] } },
    });
    expect(rows).toEqual([]);
  });

  it('another issuing country is another document, and it opens', async () => {
    const a = who();
    const b = who();
    await opening.open(
      a.id,
      claims(a),
      dto({ nationality: 'GB', idNumber: 'SHARED-NUMBER-5' }),
      null,
    );
    await opening.open(
      b.id,
      claims(b),
      dto({ nationality: 'GH', idNumber: 'SHARED-NUMBER-5' }),
      null,
    );
    expect(sent).toHaveLength(2);
  });

  it('the refusal for a document someone else holds does not talk of a BVN', async () => {
    const a = who();
    const b = who();
    await opening.open(a.id, claims(a), dto({ idNumber: 'HELD-DOC-9' }), null);
    const refused = await opening
      .open(b.id, claims(b), dto({ idNumber: 'HELD-DOC-9' }), null)
      .then(
        () => null,
        (e: { response: { message: string } }) => e.response.message,
      );
    expect(refused).toMatch(/ID or phone number/);
    expect(refused).not.toMatch(/BVN/);
  });

  it('a phone without its country code cannot open', async () => {
    const p = who('08012345678');
    await expect(
      opening.open(p.id, claims(p), dto({ idNumber: 'NOPHONE-1' }), null),
    ).rejects.toMatchObject({ code: 'account_not_opened' });
    expect(sent).toEqual([]);
  });

  it('the details still asked for are named when they are missing', async () => {
    const p = who();
    await expect(
      opening.open(p.id, claims(p), dto({ postalCode: undefined }), null),
    ).rejects.toMatchObject({
      response: { message: 'postalCode is required to open this wallet' },
    });
    expect(sent).toEqual([]);
  });

  it('when the provider asks for more, the app is told which fields, never a value', async () => {
    const p = who();
    mode = {
      refuse: [
        'person.ssn: The person.ssn field is required for U.S. nationals.',
        'identification.document.number: is not valid',
      ],
    };
    await expect(
      opening.open(p.id, claims(p), dto({ idNumber: 'ASKS-MORE-1' }), null),
    ).rejects.toMatchObject({
      code: 'account_not_opened',
      response: {
        reason: { fields: ['person.ssn', 'identification.document.number'] },
      },
    });
    // Nothing was made: the claim on the document is let go for another try.
    const row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(row.state).toBe('failed');
    expect(row.bvnHash.startsWith('released:')).toBe(true);
  });

  it('a Nigerian opening is unchanged: the numbers go, NG is the country, and it cannot be finished as a world one', async () => {
    const p = who('+2348012345678');
    const ng = plainToInstance(OpenNairaWalletDto, {
      ...US_BODY,
      countryCode: undefined,
      firstCurrency: undefined,
      bvn: '22222222222',
      nin: '33333333333',
      idNumber: 'A0000NG01',
    });
    await opening.open(p.id, claims(p), ng, null);
    expect(sent[0]).toMatchObject({ bvn: '22222222222', nin: '33333333333' });
    expect(sent[0].review).toMatchObject({
      nationality: 'NG',
      address: { countryCode: 'NG' },
      idDocument: { issuingCountry: 'NG' },
    });
    expect(sent[0].review?.world).toBeUndefined();
    const row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    expect(row.worldCountry).toBeNull();
    expect(row.worldFirstCurrency).toBeNull();
    // The same account now says it lives elsewhere: not a second kind of opening.
    await expect(
      opening.open(p.id, claims(p), dto({ idNumber: 'A0000NG01' }), null),
    ).rejects.toMatchObject({ code: 'account_not_opened' });
    expect(sent).toHaveLength(1);
  });

  describe('the Nuvion adapter’s own body', () => {
    function areaWith(): {
      area: NuvionOpeningArea;
      bodies: Array<Record<string, unknown>>;
    } {
      const bodies: Array<Record<string, unknown>> = [];
      const client = {
        post: (_op: unknown, _path: string, body: Record<string, unknown>) => {
          bodies.push(body);
          return Promise.resolve({
            httpStatus: 201,
            requestId: 'r1',
            data: {
              entity: {
                id: '01ENTAAAAAAAAAAAAAAAAAAAAA',
                type: 'individual',
                status: 'incomplete',
              },
              person: { id: '01PERAAAAAAAAAAAAAAAAAAAAA' },
            },
          });
        },
      } as unknown as NuvionClient;
      return { area: new NuvionOpeningArea(client), bodies };
    }
    const review = (extra: Record<string, unknown>) => ({
      middleName: null,
      gender: 'male' as const,
      nationality: 'GB',
      address: {
        line1: '221B Baker Street',
        line2: null,
        city: 'London',
        state: 'England',
        postalCode: 'NW1 6XE',
        countryCode: 'GB',
      },
      idDocument: {
        type: 'national_id' as const,
        number: 'ID123456',
        issueDate: null,
        expiryDate: null,
        issuingCountry: 'GB',
      },
      proofOfAddressType: 'utility_bill' as const,
      customerId: null,
      numbersAgain: true,
      lostAttemptAt: null,
      ...extra,
    });
    const input = (r: ReturnType<typeof review>, bvn: string, nin: string) => ({
      firstName: 'Alex',
      lastName: 'Johnson',
      phone: '+442071234567',
      email: 'alex@example.com',
      address: '221B Baker Street',
      dateOfBirth: '1990-04-12',
      bvn,
      nin,
      review: r,
    });

    it('sends no BVN, no NIN and no NIN subtype for a person outside Nigeria', async () => {
      const { area, bodies } = areaWith();
      await area.openWallet(input(review({ world: true }), '', ''));
      const body = bodies[0] as {
        person: Record<string, unknown>;
        address: Record<string, unknown>;
        identification: { document: Record<string, unknown> };
      };
      expect(body.person).not.toHaveProperty('bvn');
      expect(body.person).not.toHaveProperty('nin');
      expect(body.person).toMatchObject({
        nationality: 'GB',
        phonenumber: '+442071234567',
      });
      expect(body.address.country_code).toBe('GB');
      expect(body.identification.document).toMatchObject({
        type: 'national_id',
        issuing_country: 'GB',
      });
      expect(body.identification.document).not.toHaveProperty('type_specific');
    });

    it('still sends both numbers, and the NIN subtype, for a Nigerian', async () => {
      const { area, bodies } = areaWith();
      await area.openWallet(
        input(
          review({
            nationality: 'NG',
            address: {
              line1: '1 Marina',
              line2: null,
              city: 'Lagos',
              state: 'Lagos',
              postalCode: '100001',
              countryCode: 'NG',
            },
            idDocument: {
              type: 'national_id',
              number: 'ID123456',
              issueDate: null,
              expiryDate: null,
              issuingCountry: 'NG',
            },
          }),
          '22222222222',
          '33333333333',
        ),
      );
      const body = bodies[0] as {
        person: Record<string, unknown>;
        identification: { document: Record<string, unknown> };
      };
      expect(body.person).toMatchObject({
        bvn: '22222222222',
        nin: '33333333333',
      });
      expect(body.identification.document.type_specific).toEqual({
        id_subtype: 'NIN',
      });
    });
  });
});
