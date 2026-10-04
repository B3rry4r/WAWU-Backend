import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConsoleLogger,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { FintavaDouble } from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { NO_WALLET_MESSAGE } from '../../gate/wallet-gate';
import { MoneyModule } from '../../money.module';
import type { RecipientView } from '../../money-view.type';
import {
  RECENT_RECIPIENTS_MAX,
  RECIPIENT_SEARCH_MAX,
} from '../recipient-config';
import {
  SEARCH_TOO_SHORT_MESSAGE,
  readRecipientQuery,
} from '../recipient-query';

/**
 * Finding a person to send money to (task WALLET-08, W7) over HTTP: the real
 * MoneyModule, a real database, real RS256 tokens checked against the mock
 * WAWU ID's JWKS (WAWU_ID_JWKS_URL). WAWU ID's name lookup is a stand-in
 * (`identities`). Every person is a new wawuUserId that owns its rows;
 * afterAll deletes them. Names carry a per-run tag, so nobody left in the
 * database by another run can match a search here.
 */

const KEY = 'live_test_w08_0123456789FAKEKEY';
const ENV: Record<string, string> = {
  FINTAVA_BASE_URL: '',
  FINTAVA_API_KEY: KEY,
  IDENTITY_HASH_KEY: 'w08-test-identity-hash-key-0123456789abcdef',
};

/**
 * Six random letters: the start of every name and handle one test makes, so
 * no other test (or run) can match its searches. A new one before each test.
 */
const newTag = () =>
  Array.from({ length: 6 }, () => String.fromCharCode(97 + randomInt(26))).join(
    '',
  );
let TAG = newTag();

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `w08-${sub}@test.wawu.dev`,
      phone: '+2348031234412',
      firstName: 'Recipient',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
  );
}

type Envelope<T> = {
  statusCode: number;
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};

/** Every answer this file reads, for the leak check. */
const answered: string[] = [];
const body = <T>(res: Response): Envelope<T> => {
  answered.push(res.text);
  return res.body as Envelope<T>;
};

/** Names WAWU ID gives people, keyed by id (a stand-in for /internal/users/lookup). */
const identities = new Map<
  string,
  { firstName: string | null; lastName: string | null }
>();
const fakeWawuId = {
  lookupPublicIdentities: (ids: string[]) =>
    Promise.resolve(
      new Map(
        ids
          .filter((id) => identities.has(id))
          .map((id) => [
            id,
            { ...identities.get(id)!, verificationTier: 'basic' },
          ]),
      ),
    ),
};

/** `+234` and ten digits, unique to this call. */
const usedPhones = new Set<string>();
/** Phones a test writes into a handle on purpose, so they show in that answer. */
const spoofedPhones = new Set<string>();
function newPhone(): string {
  for (;;) {
    const phone = `+23490${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    if (!usedPhones.has(phone)) {
      usedPhones.add(phone);
      return phone;
    }
  }
}
const local = (e164: string) => `0${e164.slice(4)}`;

describe('Recipient search and recent recipients (WALLET-08) over HTTP', () => {
  const logger = new ConsoleLogger({
    logLevels: ['error', 'fatal'],
  });
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const double = new FintavaDouble();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let counter = 0;

  type Person = {
    id: string;
    auth: string;
    phone: string;
    account: string;
    email: string;
  };

  function person(): Person {
    const id = randomUUID();
    users.push(id);
    counter += 1;
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      phone: newPhone(),
      account: `17${String(Date.now()).slice(-5)}${String(counter).padStart(3, '0')}`,
      email: `w08-${id}@test.wawu.dev`,
    };
  }

  type HolderOptions = {
    /** The name on the wallet. Default: none. */
    wallet?: string | null;
    handle?: string | null;
    /** The name WAWU ID gives. */
    wawu?: [string, string];
    avatar?: string;
    /** Opened through MONEY-12 (the opening row), the identity row, or both. */
    phoneIn?: 'opening' | 'identity' | 'both';
    /** The phone the wallet was opened with. Default: a new one. */
    phone?: string;
    creatorTick?: boolean;
    professionalTick?: boolean;
  };

  /** A person whose wallet is open, with the phone their wallet was opened with. */
  async function holder(o: HolderOptions = {}): Promise<Person> {
    const who = person();
    if (o.phone) {
      who.phone = o.phone;
      usedPhones.add(o.phone);
    }
    if (o.handle !== undefined || o.avatar || o.creatorTick || o.wawu) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: who.id,
          accountType: 'user',
          handle: o.handle ?? null,
          avatarUrl: o.avatar ?? null,
          creatorVerifiedAt: o.creatorTick ? new Date() : null,
          professionalVerifiedAt: o.professionalTick ? new Date() : null,
        },
      });
    }
    if (o.wawu) {
      identities.set(who.id, { firstName: o.wawu[0], lastName: o.wawu[1] });
    }
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: who.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: who.account,
        accountName: o.wallet ?? null,
      },
    });
    const where = o.phoneIn ?? 'opening';
    if (where === 'opening' || where === 'both') {
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: who.id,
          state: 'open',
          bvnHash: randomUUID(),
          bvnVerifiedAt: new Date(),
          phone: who.phone,
        },
      });
    }
    if (where === 'identity' || where === 'both') {
      await prisma.walletIdentity.create({
        data: {
          wawuUserId: who.id,
          bvnHash: randomUUID(),
          bvnLast4: '4321',
          ninLast4: '8765',
          bvnVerifiedAt: new Date(),
          verifiedPhone: who.phone,
        },
      });
    }
    return who;
  }

  /** A person with no wallet, only an account and a handle. */
  async function walletless(handle: string): Promise<Person> {
    const who = person();
    await prisma.userProfile.create({
      data: { wawuUserId: who.id, accountType: 'user', handle },
    });
    return who;
  }

  const http = () => request(app.getHttpServer());
  const search = (who: Person | null, q: string | undefined) => {
    const req = http().get('/api/hub/money/recipients');
    if (q !== undefined) req.query({ q });
    return who ? req.set('Authorization', who.auth) : req;
  };
  const recent = (who: Person | null) => {
    const req = http().get('/api/hub/money/recipients/recent');
    return who ? req.set('Authorization', who.auth) : req;
  };
  const found = async (who: Person, q: string): Promise<RecipientView[]> =>
    body<RecipientView[]>(await search(who, q).expect(200)).data!;
  const ids = (list: RecipientView[]) => list.map((r) => r.wawuUserId);

  let ledgerCount = 0;
  /** One row of `from`'s ledger, as the ledger consumer writes a send. */
  async function sent(
    from: Person,
    to: Person | null,
    o: {
      at?: Date;
      status?: 'pending' | 'completed' | 'failed' | 'reversed';
      direction?: 'in' | 'out';
      kind?: 'wawu_user' | 'bank_account' | 'wawu';
      category?: 'transfer' | 'purchase' | 'top_up' | 'earning' | 'refund';
      walletKind?: 'user' | 'merchant';
    } = {},
  ) {
    ledgerCount += 1;
    await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: o.walletKind ?? 'user',
        wawuUserId: from.id,
        accountNumber: from.account,
        direction: o.direction ?? 'out',
        status: o.status ?? 'completed',
        category: o.category ?? 'transfer',
        amountKobo: 100_000n,
        totalKobo: 100_000n,
        counterpartyKind: o.kind ?? 'wawu_user',
        counterpartyWawuUserId: o.kind === 'bank_account' ? null : to?.id,
        counterpartyAccountNumber: to?.account ?? null,
        source: 'send',
        occurredAt: o.at ?? new Date(Date.now() - ledgerCount),
      },
    });
  }

  const block = (by: Person, target: Person) =>
    prisma.blockedAccount.create({
      data: { userWawuId: by.id, blockedWawuId: target.id },
    });

  beforeEach(() => {
    TAG = newTag();
  });

  beforeAll(async () => {
    await double.start();
    ENV.FINTAVA_BASE_URL = double.baseUrl;
    for (const [k, v] of Object.entries(ENV)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WawuIdClient)
      .useValue(fakeWawuId)
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication({ logger });
    app.useLogger(logger);
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { wawuUserId: { in: users } },
            { counterpartyWawuUserId: { in: users } },
          ],
        },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: users } }, { blockedWawuId: { in: users } }],
        },
      });
      await prisma.walletIdentity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    if (app) await app.close();
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('who may ask', () => {
    it('answers 401 without a token on both routes', async () => {
      await search(null, 'ab').expect(401);
      await recent(null).expect(401);
    });

    it('answers 409 wallet_not_open to someone with no wallet, before it reads the search', async () => {
      const nobody = person();
      for (const res of [
        await search(nobody, 'ab'),
        // The search text is not even read: a bad one gets the gate's answer.
        await search(nobody, 'a'),
        await recent(nobody),
      ]) {
        expect(res.status).toBe(409);
        const b = body<unknown>(res);
        expect(b.data).toBeNull();
        expect(b.reason).toMatchObject({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
      }
    });

    it('answers 409 wallet_opening while the account is still being opened', async () => {
      const opening = person();
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: opening.id,
          state: 'opening',
          bvnHash: randomUUID(),
          bvnVerifiedAt: new Date(),
          phone: opening.phone,
        },
      });
      for (const res of [await search(opening, 'ab'), await recent(opening)]) {
        expect(res.status).toBe(409);
        expect(body<unknown>(res).reason?.code).toBe('wallet_opening');
      }
    });

    it('never asks Fintava, and sends no-store', async () => {
      const me = await holder({});
      const res = await search(me, `${TAG}zz`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect((await recent(me).expect(200)).headers['cache-control']).toBe(
        'no-store',
      );
      expect(double.seen).toEqual([]);
    });
  });

  describe('a phone', () => {
    it('is the same person written 080..., 80..., 234... and +234... (and with spaces, dashes and brackets)', async () => {
      const me = await holder({});
      const ada = await holder({
        wallet: `${TAG.toUpperCase()}ADA OKORO`,
        handle: `${TAG}ada`,
        avatar: 'https://cdn.test.wawu.dev/ada.jpg',
        creatorTick: true,
      });
      const national = ada.phone.slice(4);
      const spellings = [
        ada.phone,
        `234${national}`,
        `0${national}`,
        national,
        `+234 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`,
        `0${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`,
        `(0${national.slice(0, 3)}) ${national.slice(3)}`,
        `  ${local(ada.phone)}  `,
      ];
      const answers = [];
      for (const q of spellings) answers.push(await found(me, q));
      for (const answer of answers) {
        expect(answer).toEqual([
          {
            wawuUserId: ada.id,
            displayName: `${TAG.toUpperCase()}ADA OKORO`,
            handle: `${TAG}ada`,
            avatarUrl: 'https://cdn.test.wawu.dev/ada.jpg',
            tick: 'creator',
          },
        ]);
      }
    });

    it('finds a person whose phone only the identity check holds, and one found through both', async () => {
      const me = await holder({});
      const viaIdentity = await holder({
        wallet: `${TAG}IDENT ONE`,
        phoneIn: 'identity',
      });
      const viaBoth = await holder({
        wallet: `${TAG}BOTH ONE`,
        phoneIn: 'both',
      });
      expect(ids(await found(me, local(viaIdentity.phone)))).toEqual([
        viaIdentity.id,
      ]);
      expect(ids(await found(me, viaBoth.phone))).toEqual([viaBoth.id]);
    });

    it('is never matched in part: not a prefix, a suffix, one digit short or one too many', async () => {
      const me = await holder({});
      const target = await holder({ wallet: `${TAG}PART ONE` });
      const national = target.phone.slice(4);
      const parts = [
        local(target.phone).slice(0, 7),
        local(target.phone).slice(0, 10),
        `+234${national.slice(0, 6)}`,
        national.slice(2),
        national.slice(-7),
        `0${national}0`,
        `+234${national}1`,
        `2340${national}`,
        `${local(target.phone).slice(0, 4)} ${local(target.phone).slice(4, 8)}`,
      ];
      for (const q of parts) {
        const answer = await search(me, q).expect(200);
        expect({ q, ids: ids(body<RecipientView[]>(answer).data!) }).toEqual({
          q,
          ids: [],
        });
      }
    });

    it('reads digits written in another script as text, never as the phone: fullwidth, Arabic-Indic, Devanagari, superscript', async () => {
      const me = await holder({});
      const target = await holder({ wallet: `${TAG}SCRIPT ONE` });
      const ascii = local(target.phone);
      const written = (zero: number) =>
        [...ascii].map((d) => String.fromCodePoint(zero + Number(d))).join('');
      const forms = [
        written(0xff10), // fullwidth
        written(0x0660), // Arabic-Indic
        written(0x06f0), // Eastern Arabic-Indic
        written(0x0966), // Devanagari
        `+２３４${[...target.phone.slice(4)].map((d) => String.fromCodePoint(0xff10 + Number(d))).join('')}`,
        // One ASCII digit among them is still not a phone.
        `${ascii.slice(0, 1)}${written(0xff10).slice(1)}`,
        `${[...ascii.slice(0, 10)].map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('')}${ascii.slice(10)}`,
      ];
      for (const q of forms) {
        expect(readRecipientQuery(q).kind).toBe('name');
        const res = await search(me, q).expect(200);
        expect({ q, ids: ids(body<RecipientView[]>(res).data!) }).toEqual({
          q,
          ids: [],
        });
      }
      // The same number in ASCII does find them.
      expect(ids(await found(me, ascii))).toEqual([target.id]);
      // A 9-digit text is a name text, not a number with a digit put in front.
      expect(readRecipientQuery(target.phone.slice(5)).kind).toBe('name');
      expect(readRecipientQuery(local(target.phone).slice(0, 10)).kind).toBe(
        'name',
      );
    });

    it('does not match a number that only shares its last digits, or its first', async () => {
      const me = await holder({});
      // Eight random digits, then the same eight under another network
      // prefix, then the first seven of them with a last digit apart.
      const tail = String(randomInt(0, 100_000_000)).padStart(8, '0');
      const lastDigit = Number(tail[7]);
      const other = (lastDigit + 1) % 10;
      const target = await holder({
        wallet: `${TAG}NEAR ONE`,
        phone: `+23490${tail}`,
      });
      const sameTail = await holder({
        wallet: `${TAG}NEAR TAIL`,
        phone: `+23480${tail}`,
        phoneIn: 'identity',
      });
      const sameHead = await holder({
        wallet: `${TAG}NEAR HEAD`,
        phone: `+23490${tail.slice(0, 7)}${other}`,
        phoneIn: 'both',
      });
      expect(ids(await found(me, `+23490${tail}`))).toEqual([target.id]);
      expect(ids(await found(me, `080${tail}`))).toEqual([sameTail.id]);
      expect(ids(await found(me, `23490${tail.slice(0, 7)}${other}`))).toEqual([
        sameHead.id,
      ]);
      expect(ids(await found(me, `090${tail}`))).toEqual([target.id]);
    });

    it('is searched as a phone and nothing else: a handle written as a number does not stand in for the number', async () => {
      const me = await holder({});
      const owner = await holder({ wallet: `${TAG}OWNER ONE` });
      spoofedPhones.add(owner.phone);
      const spoof = await holder({
        wallet: `${TAG}SPOOF ONE`,
        handle: local(owner.phone),
      });
      expect(ids(await found(me, local(owner.phone)))).toEqual([owner.id]);
      expect(ids(await found(me, `+234${owner.phone.slice(4)}`))).toEqual([
        owner.id,
      ]);
      expect(spoof.id).not.toBe(owner.id);
    });

    it('is a plain miss for a Nigerian number nobody opened a wallet with', async () => {
      const me = await holder({});
      const res = await search(me, '08031230000').expect(200);
      expect(body<RecipientView[]>(res).data).toEqual([]);
      const elsewhere = await search(me, '+14155550100').expect(200);
      expect(body<RecipientView[]>(elsewhere).data).toEqual([]);
    });
  });

  describe('a name or a @handle', () => {
    it('matches by its beginning, ignoring case, and by the beginning of any word of the name', async () => {
      const me = await holder({});
      const ada = await holder({
        wallet: `${TAG.toUpperCase()}ADAEZE OKORO`,
        handle: `${TAG}ada.o`,
      });
      for (const q of [
        `${TAG}ada`,
        `${TAG.toUpperCase()}ADA`,
        `${TAG}Adaeze Ok`,
        `  ${TAG}ADAEZE   OKORO  `,
        'okoro',
        'OKO',
      ]) {
        const answer = await found(me, q);
        // 'okoro' and 'oko' are any word: other people in the database may
        // share it, so look for her rather than for only her.
        if (q.toLowerCase().startsWith('oko'))
          expect(ids(answer)).toContain(ada.id);
        else expect(ids(answer)).toEqual([ada.id]);
      }
      // Not the middle of a word, and not the middle of the name.
      expect(await found(me, `${TAG.slice(1)}adaeze`)).toEqual([]);
      expect(await found(me, `${TAG}aeze`)).toEqual([]);
    });

    it('matches a handle by its beginning, with or without the @, and @ means a handle only', async () => {
      const me = await holder({});
      const byHandle = await holder({
        wallet: `QQ ${TAG.toUpperCase()}OTHER`,
        handle: `${TAG}Tolu_9`,
      });
      const byName = await holder({
        wallet: `${TAG.toUpperCase()}TOLUWA BELLO`,
        handle: null,
      });
      expect(ids(await found(me, `@${TAG}tolu`))).toEqual([byHandle.id]);
      expect(ids(await found(me, `@${TAG}TOLU_9`))).toEqual([byHandle.id]);
      expect(ids(await found(me, `${TAG}tolu`)).sort()).toEqual(
        [byHandle.id, byName.id].sort(),
      );
      // The name starts like that, the handle does not: @ will not read names.
      expect(await found(me, `@${TAG}toluwa`)).toEqual([]);
    });

    it('treats % and _ as the characters they are, never as wildcards', async () => {
      const me = await holder({});
      await holder({ wallet: `${TAG}PCT ONE`, handle: `${TAG}pct_1` });
      expect(await found(me, '%%')).toEqual([]);
      expect(await found(me, '__')).toEqual([]);
      expect(await found(me, `${TAG}%`)).toEqual([]);
      expect(await found(me, `@${TAG}pct_`)).toHaveLength(1);
      expect(await found(me, `@${TAG}pct%`)).toEqual([]);
      expect(await found(me, `${TAG}p_t`)).toEqual([]);
      expect(await found(me, '\\\\')).toEqual([]);
    });

    it('shows the name WAWU ID gives, else the name on the wallet, else the handle; one tick, creator first', async () => {
      const me = await holder({});
      const named = await holder({
        wallet: `${TAG}WALLET NAME`,
        handle: `${TAG}named`,
        wawu: ['Ngozi', 'Eze'],
        creatorTick: true,
        professionalTick: true,
      });
      const walletOnly = await holder({
        wallet: `${TAG}WALLET ONLY`,
        handle: `${TAG}walletonly`,
        professionalTick: true,
      });
      const handleOnly = await holder({
        wallet: null,
        handle: `${TAG}handleonly`,
      });
      const [a] = await found(me, `@${TAG}named`);
      expect(a).toEqual({
        wawuUserId: named.id,
        displayName: 'Ngozi Eze',
        handle: `${TAG}named`,
        avatarUrl: null,
        tick: 'creator',
      });
      const [b] = await found(me, `@${TAG}walletonly`);
      expect(b).toMatchObject({
        wawuUserId: walletOnly.id,
        displayName: `${TAG}WALLET ONLY`,
        tick: 'professional',
      });
      const [c] = await found(me, `@${TAG}handleonly`);
      expect(c).toMatchObject({
        wawuUserId: handleOnly.id,
        displayName: `${TAG}handleonly`,
        tick: null,
      });
    });

    it('lists people in name order, then id', async () => {
      const me = await holder({});
      const names = ['MMM', 'AAA', 'ZZZ', 'BBB'];
      const made: Person[] = [];
      for (const n of names) {
        made.push(await holder({ wallet: `${TAG}${n}` }));
      }
      const answer = await found(me, TAG);
      expect(answer.map((r) => r.displayName)).toEqual(
        names.map((n) => `${TAG}${n}`).sort((x, y) => x.localeCompare(y)),
      );
      expect(made).toHaveLength(4);
    });
  });

  describe('a search that is too short, or too long', () => {
    it.each([
      ['one letter', 'a'],
      ['one letter with spaces around it', '   a   '],
      ['only spaces', '     '],
      ['an empty text', ''],
      ['@ and one letter', '@a'],
      ['only an @', '@'],
      ['@ and spaces', '@   '],
      ['one digit', '8'],
    ])('is a 400 in the one error shape: %s', async (_label, q) => {
      const me = await holder({});
      const res = await search(me, q).expect(400);
      const b = body<unknown>(res);
      expect(b).toMatchObject({ statusCode: 400, data: null });
      expect(typeof b.message === 'string' || Array.isArray(b.message)).toBe(
        true,
      );
      expect(JSON.stringify(b)).not.toContain('—');
    });

    it('is a 400 when q is missing, repeated, longer than 60, or sent with another field', async () => {
      const me = await holder({});
      await search(me, undefined).expect(400);
      await http()
        .get('/api/hub/money/recipients?q=ab&q=cd')
        .set('Authorization', me.auth)
        .expect(400);
      await search(me, 'a'.repeat(61)).expect(400);
      await search(me, `${'a'.repeat(30)} ${'b'.repeat(40)}`).expect(400);
      await search(me, 'a'.repeat(60)).expect(200);
      await http()
        .get('/api/hub/money/recipients?q=ab&limit=100')
        .set('Authorization', me.auth)
        .expect(400);
    });

    it('takes exactly 2 characters once trimmed, and the @ is not one of them', async () => {
      const me = await holder({});
      await search(me, ' ab ').expect(200);
      await search(me, '@ab').expect(200);
      await search(me, '@a').expect(400);
      await search(me, 'a ').expect(400);
      // A NUL byte cannot reach the database: it is dropped, never a 500.
      await search(me, 'a\u0000').expect(400);
      await search(me, 'a\u0000b').expect(200);
    });

    it('reads the text the way the route does (unit)', () => {
      expect(readRecipientQuery('  Ada   Okoro ')).toEqual({
        kind: 'name',
        prefix: 'Ada Okoro',
      });
      expect(readRecipientQuery('@Ada')).toEqual({
        kind: 'handle',
        prefix: 'Ada',
      });
      expect(readRecipientQuery('080 3123 4567')).toEqual({
        kind: 'phone',
        e164: '+2348031234567',
      });
      expect(readRecipientQuery('2348031234567')).toEqual({
        kind: 'phone',
        e164: '+2348031234567',
      });
      expect(readRecipientQuery('8031234567')).toEqual({
        kind: 'phone',
        e164: '+2348031234567',
      });
      // Digits that are not a whole mobile are text, never a partial phone.
      expect(readRecipientQuery('0803123')).toEqual({
        kind: 'name',
        prefix: '0803123',
      });
      expect(() => readRecipientQuery('x')).toThrow(SEARCH_TOO_SHORT_MESSAGE);
    });
  });

  describe('who is never found', () => {
    it('a person with no open wallet, whatever they are searched by', async () => {
      const me = await holder({});
      const none = await walletless(`${TAG}nowallet`);
      const opening = person();
      await prisma.userProfile.create({
        data: {
          wawuUserId: opening.id,
          accountType: 'user',
          handle: `${TAG}opening`,
        },
      });
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: opening.id,
          state: 'opening',
          bvnHash: randomUUID(),
          bvnVerifiedAt: new Date(),
          phone: opening.phone,
        },
      });
      // A proved phone without a wallet, too.
      const proved = person();
      await prisma.walletIdentity.create({
        data: {
          wawuUserId: proved.id,
          bvnHash: randomUUID(),
          bvnVerifiedAt: new Date(),
          verifiedPhone: proved.phone,
        },
      });
      expect(await found(me, `@${TAG}nowallet`)).toEqual([]);
      expect(await found(me, `${TAG}nowallet`)).toEqual([]);
      expect(await found(me, `@${TAG}opening`)).toEqual([]);
      expect(await found(me, opening.phone)).toEqual([]);
      expect(await found(me, local(proved.phone))).toEqual([]);
      expect(none.id).not.toBe(opening.id);
    });

    it('the caller themself, by name, handle or phone', async () => {
      const me = await holder({
        wallet: `${TAG.toUpperCase()}MYSELF ONLY`,
        handle: `${TAG}myself`,
      });
      const other = await holder({ wallet: `${TAG.toUpperCase()}MYSELF TWO` });
      expect(await found(me, `@${TAG}myself`)).toEqual([]);
      expect(await found(me, me.phone)).toEqual([]);
      expect(await found(me, local(me.phone))).toEqual([]);
      // Someone else with a like name is found, so the miss is the caller's own.
      expect(ids(await found(me, `${TAG}myself`))).toEqual([other.id]);
    });

    it('a person whose account was deleted and whose wallet went with it', async () => {
      const me = await holder({});
      const gone = await holder({
        wallet: `${TAG}GONE ONE`,
        handle: `${TAG}gone`,
      });
      expect(ids(await found(me, `@${TAG}gone`))).toEqual([gone.id]);
      await prisma.fintavaWallet.delete({ where: { wawuUserId: gone.id } });
      expect(await found(me, `@${TAG}gone`)).toEqual([]);
      expect(await found(me, gone.phone)).toEqual([]);
    });
  });

  describe('blocked either way', () => {
    it('hides the person in a name, a handle and a phone search, whoever blocked whom, and returns them on unblocking', async () => {
      const me = await holder({});
      const iBlocked = await holder({
        wallet: `${TAG}BLK MINE`,
        handle: `${TAG}blkmine`,
      });
      const blockedMe = await holder({
        wallet: `${TAG}BLK THEIRS`,
        handle: `${TAG}blktheirs`,
      });
      const free = await holder({
        wallet: `${TAG}BLK FREE`,
        handle: `${TAG}blkfree`,
      });
      await block(me, iBlocked);
      await block(blockedMe, me);
      expect(ids(await found(me, `${TAG}blk`))).toEqual([free.id]);
      expect(ids(await found(me, `@${TAG}blk`))).toEqual([free.id]);
      expect(await found(me, iBlocked.phone)).toEqual([]);
      expect(await found(me, local(blockedMe.phone))).toEqual([]);
      expect(ids(await found(me, free.phone))).toEqual([free.id]);
      // The block is between two people: the others still see each other.
      const bystander = await holder({});
      expect(ids(await found(bystander, `${TAG}blk`)).sort()).toEqual(
        [iBlocked.id, blockedMe.id, free.id].sort(),
      );
      // And from the other side, the same.
      expect(ids(await found(iBlocked, `${TAG}blk`)).sort()).toEqual(
        [blockedMe.id, free.id].sort(),
      );
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: me.id, blockedWawuId: iBlocked.id },
      });
      expect(ids(await found(me, `${TAG}blk`)).sort()).toEqual(
        [iBlocked.id, free.id].sort(),
      );
    });

    it('answers a blocked person exactly as it answers someone who does not exist', async () => {
      const me = await holder({});
      const blocked = await holder({ wallet: `${TAG}SAME ANSWER` });
      await block(me, blocked);
      const a = await search(me, blocked.phone).expect(200);
      const b = await search(me, newPhone()).expect(200);
      expect(a.text).toBe(b.text);
      expect(a.status).toBe(b.status);
    });
  });

  describe('no private detail ever leaves', () => {
    it('a result has five fields and none of them is a phone, an account number, an email, a BVN or a NIN', async () => {
      const me = await holder({});
      const a = await holder({
        wallet: `${TAG.toUpperCase()}LEAK ONE`,
        handle: `${TAG}leak1`,
        wawu: ['Leak', 'One'],
        phoneIn: 'both',
      });
      const b = await holder({
        wallet: `${TAG.toUpperCase()}LEAK TWO`,
        handle: `${TAG}leak2`,
      });
      await sent(me, a);
      await sent(me, b);
      const texts: string[] = [];
      for (const q of [
        a.phone,
        local(a.phone),
        `${TAG}leak`,
        `@${TAG}leak1`,
        b.phone,
      ]) {
        const res = await search(me, q).expect(200);
        texts.push(res.text);
        for (const r of body<RecipientView[]>(res).data!) {
          expect(Object.keys(r).sort()).toEqual([
            'avatarUrl',
            'displayName',
            'handle',
            'tick',
            'wawuUserId',
          ]);
        }
      }
      texts.push((await recent(me).expect(200)).text);
      for (const text of texts) {
        for (const secret of [
          a.phone,
          local(a.phone),
          a.phone.slice(4),
          a.phone.slice(-8),
          a.account,
          a.email,
          'test.wawu.dev',
          b.phone.slice(-8),
          b.account,
          b.email,
          '4321',
          '8765',
          'bvn',
          'nin',
          'verifiedPhone',
          'accountNumber',
          'accountName',
        ]) {
          expect({ secret, leaked: text.includes(secret) }).toEqual({
            secret,
            leaked: false,
          });
        }
      }
      // Whatever was answered in this file, for any person made here.
      for (const text of answered) {
        expect(text).not.toMatch(/\+234\d{10}/);
        for (const phone of usedPhones) {
          if (spoofedPhones.has(phone)) continue;
          expect(text).not.toContain(phone);
          expect(text).not.toContain(local(phone));
        }
      }
    });
  });

  describe('the size of an answer', () => {
    it('answers at most 20 people, the first 20 in name order, and 20 is the declared maximum', async () => {
      const me = await holder({});
      const names: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        const n = `${TAG}CAP${String(i).padStart(2, '0')}`;
        names.push(n);
        await holder({ wallet: n });
      }
      const answer = await found(me, `${TAG}cap`);
      expect(RECIPIENT_SEARCH_MAX).toBe(20);
      expect(answer).toHaveLength(20);
      expect(answer.map((r) => r.displayName)).toEqual(names.slice(0, 20));
    }, 30_000);
  });

  describe('the contract', () => {
    type Op = {
      responses: Record<
        string,
        { content?: Record<string, { schema?: Record<string, unknown> }> }
      >;
      'x-wawu-served'?: boolean;
    };
    const spec = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../contract/openapi.json'),
        'utf8',
      ),
    ) as { paths: Record<string, { get: Op }> };

    it('serves both routes, declares the search 400 and 429 beside the gate answers, and states the maximum on both arrays', () => {
      const search = spec.paths['/api/hub/money/recipients'].get;
      const recent = spec.paths['/api/hub/money/recipients/recent'].get;
      expect(search['x-wawu-served']).toBeUndefined();
      expect(recent['x-wawu-served']).toBeUndefined();
      expect(Object.keys(search.responses).sort()).toEqual([
        '200',
        '400',
        '409',
        '423',
        '429',
      ]);
      expect(
        search.responses['400'].content?.['application/json'].schema,
      ).toEqual({ $ref: '#/components/schemas/MoneyPlainErrorEnvelope' });
      expect(
        search.responses['429'].content?.['application/json'].schema,
      ).toEqual({ $ref: '#/components/schemas/MoneyErrorEnvelope' });
      expect(
        search.responses['200'].content?.['application/json'].schema,
      ).toMatchObject({ type: 'array', maxItems: 20 });
      expect(
        recent.responses['200'].content?.['application/json'].schema,
      ).toMatchObject({ type: 'array', maxItems: 10 });
    });
  });

  describe('recent recipients', () => {
    it('is empty for someone who has sent nothing', async () => {
      const me = await holder({});
      expect(body<RecipientView[]>(await recent(me).expect(200)).data).toEqual(
        [],
      );
    });

    it('lists each person once, newest send first, with the same fields as a search result', async () => {
      const me = await holder({});
      const ada = await holder({
        wallet: `${TAG}RCT ADA`,
        handle: `${TAG}rctada`,
        avatar: 'https://cdn.test.wawu.dev/rct.jpg',
        creatorTick: true,
      });
      const bola = await holder({ wallet: `${TAG}RCT BOLA` });
      const chi = await holder({ wallet: `${TAG}RCT CHI` });
      const now = Date.now();
      await sent(me, ada, { at: new Date(now - 50_000) });
      await sent(me, bola, { at: new Date(now - 40_000) });
      await sent(me, chi, { at: new Date(now - 30_000) });
      // Ada again, the newest of all, and an older one: still one Ada, first.
      await sent(me, ada, { at: new Date(now - 10_000) });
      await sent(me, ada, { at: new Date(now - 90_000) });
      const answer = body<RecipientView[]>(await recent(me).expect(200)).data!;
      expect(ids(answer)).toEqual([ada.id, chi.id, bola.id]);
      expect(answer[0]).toEqual({
        wawuUserId: ada.id,
        displayName: `${TAG}RCT ADA`,
        handle: `${TAG}rctada`,
        avatarUrl: 'https://cdn.test.wawu.dev/rct.jpg',
        tick: 'creator',
      });
      // A payment to a WAWU user counts the same as a transfer.
      const dee = await holder({ wallet: `${TAG}RCT DEE` });
      await sent(me, dee, { category: 'purchase', at: new Date(now) });
      expect(
        ids(body<RecipientView[]>(await recent(me).expect(200)).data!),
      ).toEqual([dee.id, ada.id, chi.id, bola.id]);
    });

    it('counts only completed money that left the caller for a WAWU user', async () => {
      const me = await holder({});
      const other = await holder({});
      const real = await holder({ wallet: `${TAG}ONLY REAL` });
      const pend = await holder({ wallet: `${TAG}PENDING` });
      const fail = await holder({ wallet: `${TAG}FAILED` });
      const rev = await holder({ wallet: `${TAG}REVERSED` });
      const came = await holder({ wallet: `${TAG}CAME IN` });
      const topUp = await holder({ wallet: `${TAG}TOP UP` });
      const earn = await holder({ wallet: `${TAG}EARNING` });
      const bank = await holder({ wallet: `${TAG}BANK SIDE` });
      const merch = await holder({ wallet: `${TAG}MERCHANT` });
      const theirs = await holder({ wallet: `${TAG}THEIRS` });
      await sent(me, real);
      await sent(me, pend, { status: 'pending' });
      await sent(me, fail, { status: 'failed' });
      await sent(me, rev, { status: 'reversed' });
      await sent(me, came, { direction: 'in' });
      await sent(me, topUp, { category: 'top_up' });
      await sent(me, earn, { category: 'earning' });
      await sent(me, bank, { kind: 'bank_account' });
      await sent(me, merch, { kind: 'wawu' });
      // Someone else's send, and a row on the merchant wallet naming the caller.
      await sent(other, theirs);
      await sent(me, theirs, { walletKind: 'merchant' });
      expect(
        ids(body<RecipientView[]>(await recent(me).expect(200)).data!),
      ).toEqual([real.id]);
      expect(
        ids(body<RecipientView[]>(await recent(other).expect(200)).data!),
      ).toEqual([theirs.id]);
    });

    it('answers at most 10 people, the newest 10, and 10 is the declared maximum', async () => {
      const me = await holder({});
      const made: Person[] = [];
      const now = Date.now();
      for (let i = 0; i < 13; i += 1) {
        const p = await holder({ wallet: `${TAG}REC${i}` });
        made.push(p);
        await sent(me, p, { at: new Date(now - (100 - i) * 1000) });
      }
      const answer = body<RecipientView[]>(await recent(me).expect(200)).data!;
      expect(RECENT_RECIPIENTS_MAX).toBe(10);
      expect(answer).toHaveLength(10);
      expect(ids(answer)).toEqual(
        made
          .slice(-10)
          .reverse()
          .map((p) => p.id),
      );
    }, 30_000);

    it('drops a person blocked either way, and one whose wallet is no longer open, and still fills the list from the rest', async () => {
      const me = await holder({});
      const mine = await holder({ wallet: `${TAG}DROP MINE` });
      const theirs = await holder({ wallet: `${TAG}DROP THEIRS` });
      const gone = await holder({
        wallet: `${TAG}DROP GONE`,
        handle: `${TAG}dropgone`,
        wawu: ['Gone', 'Away'],
      });
      const kept = await holder({ wallet: `${TAG}DROP KEPT` });
      const now = Date.now();
      await sent(me, mine, { at: new Date(now - 1000) });
      await sent(me, theirs, { at: new Date(now - 2000) });
      await sent(me, gone, { at: new Date(now - 3000) });
      await sent(me, kept, { at: new Date(now - 4000) });
      await block(me, mine);
      await block(theirs, me);
      await prisma.fintavaWallet.delete({ where: { wawuUserId: gone.id } });
      expect(
        ids(body<RecipientView[]>(await recent(me).expect(200)).data!),
      ).toEqual([kept.id]);
      // Unblocked, they are back where their last send puts them.
      await prisma.blockedAccount.deleteMany({
        where: { userWawuId: me.id, blockedWawuId: mine.id },
      });
      expect(
        ids(body<RecipientView[]>(await recent(me).expect(200)).data!),
      ).toEqual([mine.id, kept.id]);
    });

    it('never lists the caller', async () => {
      const me = await holder({ wallet: `${TAG}SELF SENDER` });
      await sent(me, me);
      expect(body<RecipientView[]>(await recent(me).expect(200)).data).toEqual(
        [],
      );
    });
  });
});
