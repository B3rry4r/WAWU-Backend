import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, LoggerService } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { BlockedAccountService } from '../../../blocked-account/blocked-account.service';
import { MeNotificationsService } from '../../../me/me-notifications.service';
import { NotificationModule } from '../../../notification/notification.module';
import { NotificationService } from '../../../notification/notification.service';
import { PushModule } from '../../../push/push.module';
import { PushSenderService } from '../../../push/push-sender.service';
import { PushTokenService } from '../../../push/push-token.service';
import { ExpoStandIn } from '../../../push/tests/expo-stand-in';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { LedgerModule } from '../../ledger/ledger.module';
import { LedgerService } from '../../ledger/ledger.service';
import type {
  LedgerCounterparty,
  LedgerLink,
  LedgerMovementInput,
} from '../../ledger/ledger.interface';
import type { TransferStatus } from '../../money-view.type';
import { MoneyInNoticeModule } from '../money-in-notice.module';
import { MoneyInNoticeService } from '../money-in-notice.service';

/**
 * Every credit is told once, and a credit taken back is corrected once (task
 * WALLET-39, R-54), against a real database, the real ledger, the real
 * NotificationService and, for the phone, the real push sender talking to the
 * Expo stand-in. Each credit is a ledger row written the way its writer
 * writes it: a friend's send (MONEY-07 / NUV-05, `transfer`), an earning
 * (WALLET-16 and a released hold, `earning`), a refund (a refunded hold,
 * `refund`) and a bank transfer in (`top_up`). Every row a spec makes belongs
 * to its own people, found by their ids, and everything is deleted at the end.
 */

const RUN = `w39${Date.now().toString(36)}`;

class QuietLogger implements LoggerService {
  log() {}
  error() {}
  warn() {}
  debug() {}
  verbose() {}
  fatal() {}
}

/** The part of the migration that marks the credits already there (WALLET-39). */
function migrationSql(): string {
  return readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
      '20261024070000_money_in_all_credits',
      'migration.sql',
    ),
    'utf8',
  );
}
const backfillOne = () => {
  const sql = migrationSql();
  const at = sql.indexOf('INSERT INTO "MoneyInNotice"');
  return sql.slice(at, sql.indexOf('-- Backfill 2', at));
};
const backfillTwo = () => {
  const sql = migrationSql();
  return sql.slice(sql.indexOf('UPDATE "MoneyInNotice"'));
};

type Source = 'transfer' | 'earning' | 'refund' | 'top_up';

describe('Money in, for every credit (WALLET-39)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let notice: MoneyInNoticeService;
  let notifications: NotificationService;
  let provider: WalletProvider;
  let config: ConfigService;
  let sender: PushSenderService;
  let tokens: PushTokenService;
  let feed: MeNotificationsService;
  const stand = new ExpoStandIn();
  const previous: Record<string, string | undefined> = {};
  const users: string[] = [];
  let seq = 0;

  const ref = (name: string) => `${name}-${RUN}-${(seq += 1)}`;

  /** A second Hub process on the same database. */
  const processOf = (name: 'fintava' | 'nuvion' = 'fintava') =>
    new MoneyInNoticeService(
      prisma,
      name === 'fintava' ? provider : ({ name } as unknown as WalletProvider),
      notifications,
      config,
    );

  async function addUser(o: { moneyIn?: boolean | null } = {}) {
    const wawuUserId = randomUUID();
    seq += 1;
    const accountNumber = `7${String(Date.now()).slice(-7)}${String(seq % 100).padStart(2, '0')}`;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber,
      },
    });
    if (o.moneyIn !== undefined) {
      await prisma.notificationSettings.create({
        data: { userWawuId: wawuUserId, moneyIn: o.moneyIn },
      });
    }
    users.push(wawuUserId);
    return { wawuUserId, accountNumber };
  }
  type Person = Awaited<ReturnType<typeof addUser>>;

  const noteOf = (person: Person, kind: string) =>
    prisma.notification.findMany({
      where: { userWawuId: person.wawuUserId, kind },
      include: { target: true },
      orderBy: { createdAt: 'asc' },
    });
  const marksOf = (person: Person) =>
    prisma.moneyInNotice.findMany({
      where: { entry: { wawuUserId: person.wawuUserId } },
      orderBy: { createdAt: 'asc' },
    });

  /**
   * One credited ledger row, written the way its writer writes it. `again`
   * with the same `customerReference` is another sighting of the same credit.
   */
  function movement(
    person: Person,
    category: Source,
    o: {
      kobo?: number;
      status?: TransferStatus;
      customerReference?: string;
      counterparty?: LedgerCounterparty | null;
      link?: LedgerLink | null;
      source?: LedgerMovementInput['source'];
    } = {},
  ): LedgerMovementInput {
    const defaults: Record<Source, LedgerCounterparty> = {
      // MONEY-07 / NUV-05: the sender's name and wallet, as the transfer wrote them.
      transfer: {
        kind: 'wawu_user',
        name: 'Tolu Bakare',
        wawuUserId: randomUUID(),
        accountNumber: '8012345678',
      },
      // WALLET-16 / a released hold: the buyer, no name, no number.
      earning: { kind: 'wawu_user', name: null, wawuUserId: randomUUID() },
      // A refunded hold: from WAWU.
      refund: { kind: 'wawu', name: null },
      // A bank transfer in: what the provider gave.
      top_up: {
        kind: 'bank_account',
        name: 'Ada Obi',
        accountNumber: '0865231291',
        bankCode: '000014',
      },
    };
    return {
      wallet: {
        kind: 'user',
        wawuUserId: person.wawuUserId,
        accountNumber: person.accountNumber,
      },
      direction: 'in',
      status: o.status ?? 'completed',
      category,
      amountKobo: o.kobo ?? 500_000,
      counterparty:
        o.counterparty === undefined ? defaults[category] : o.counterparty,
      link: o.link ?? null,
      references: { customerReference: o.customerReference ?? ref('CRED') },
      source: o.source ?? 'send',
    };
  }
  async function credit(
    person: Person,
    category: Source,
    o: Parameters<typeof movement>[2] = {},
  ) {
    const r = await ledger.record(movement(person, category, o));
    return r.entryId;
  }

  beforeAll(async () => {
    await stand.start();
    const env = { PUSH_ENABLED: 'true', EXPO_PUSH_BASE_URL: stand.baseUrl };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        NotificationModule,
        LedgerModule,
        MoneyInNoticeModule,
        PushModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new QuietLogger() });
    await app.init();
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
    notice = moduleRef.get(MoneyInNoticeService);
    notifications = moduleRef.get(NotificationService);
    provider = moduleRef.get(WALLET_PROVIDER);
    config = moduleRef.get(ConfigService);
    sender = moduleRef.get(PushSenderService);
    tokens = moduleRef.get(PushTokenService);
    feed = new MeNotificationsService(
      prisma,
      moduleRef.get(BlockedAccountService),
      { creatorsFor: () => Promise.resolve(new Map()) } as never,
    );
    expect(provider.name).toBe('fintava');
    // Credits another suite left in this database are not news to this one.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MoneyInNotice" ("entryId", "outcome")
       SELECT "id", 'before' FROM "FintavaLedgerEntry"
        WHERE "direction" = 'in' AND "walletKind" = 'user'
          AND "category" IN ('top_up', 'transfer', 'earning', 'refund')
          AND "status" <> 'pending'
       ON CONFLICT ("entryId") DO NOTHING`,
    );
    await prisma.$executeRawUnsafe(backfillTwo());
  }, 60_000);

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { userWawuId: { in: users } },
    });
    await prisma.pushDelivery.deleteMany({
      where: { userWawuId: { in: users } },
    });
    await prisma.pushToken.deleteMany({ where: { userWawuId: { in: users } } });
    await prisma.notificationSettings.deleteMany({
      where: { userWawuId: { in: users } },
    });
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
    await stand.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -------------------------------------------------------------------------
  describe('capability 1: each credit makes exactly one notice, and a repeat makes none', () => {
    it("a friend's send, a landed earning, a refund and a bank transfer in are four notices, each with its own words and its transaction", async () => {
      const ada = await addUser();
      const refs = {
        transfer: ref('SEND'),
        earning: ref('EARN'),
        refund: ref('REFU'),
        top_up: ref('BANK'),
      };
      const ids = {
        transfer: await credit(ada, 'transfer', {
          kobo: 500_000,
          customerReference: refs.transfer,
        }),
        earning: await credit(ada, 'earning', {
          kobo: 255_000,
          customerReference: refs.earning,
        }),
        refund: await credit(ada, 'refund', {
          kobo: 120_000,
          customerReference: refs.refund,
        }),
        top_up: await credit(ada, 'top_up', {
          kobo: 1_000_000,
          customerReference: refs.top_up,
        }),
      };
      expect(await notice.sweep()).toEqual({
        sent: 4,
        muted: 0,
        skipped: 0,
        failed: 0,
      });

      const notes = await noteOf(ada, 'money_in');
      expect(notes).toHaveLength(4);
      const by = (id: string) => {
        const n = notes.find((x) => x.target?.targetId === id);
        expect(n).toBeDefined();
        return n!;
      };
      expect(by(ids.transfer)).toMatchObject({
        title: 'Money received',
        body: 'You received ₦5,000 from Tolu B.',
        amount: 5000,
        tone: 'success',
      });
      expect(by(ids.earning)).toMatchObject({
        title: 'Earnings received',
        body: 'You received ₦2,550 in earnings.',
        amount: 2550,
      });
      expect(by(ids.refund)).toMatchObject({
        title: 'Refund received',
        body: 'You received a refund of ₦1,200.',
        amount: 1200,
      });
      expect(by(ids.top_up)).toMatchObject({
        title: 'Money received',
        body: 'You received ₦10,000 from Ada Obi (****1291).',
        amount: 10000,
      });
      for (const n of notes) {
        expect(n.target).toMatchObject({
          targetKind: 'transaction',
          actorWawuId: null,
        });
        expect(`${n.title} ${n.body}`).not.toMatch(/\d{6,}/);
        expect(`${n.title} ${n.body}`).not.toMatch(
          new RegExp('[\\u2014\\u2013]'),
        );
      }
      const marks = await marksOf(ada);
      expect(marks.map((m) => m.entryId).sort()).toEqual(
        Object.values(ids).sort(),
      );
      expect(marks.every((m) => m.outcome === 'sent')).toBe(true);
      expect(marks.every((m) => m.correctedAt === null)).toBe(true);

      // A repeated delivery: the same credit seen again by the webhook, the
      // history and a lookup is the same ledger row, so nobody is told again.
      for (const [category, customerReference] of Object.entries(refs)) {
        for (const source of ['webhook', 'history', 'lookup'] as const) {
          const again = await ledger.record(
            movement(ada, category as Source, { customerReference, source }),
          );
          expect(again.created).toBe(false);
        }
      }
      const none = { sent: 0, muted: 0, skipped: 0, failed: 0 };
      expect(await notice.sweep()).toEqual(none);
      expect(await processOf().sweep()).toEqual(none);
      for (const id of Object.values(ids)) {
        expect(await notice.noticeEntry(id)).toBe('skipped');
      }
      expect(await noteOf(ada, 'money_in')).toHaveLength(4);
      expect(await marksOf(ada)).toHaveLength(4);
    });

    it('is told to the person whose wallet it is, and to nobody else', async () => {
      const ada = await addUser();
      const bayo = await addUser();
      await credit(ada, 'transfer');
      await notice.sweep();
      expect(await noteOf(ada, 'money_in')).toHaveLength(1);
      expect(await noteOf(bayo, 'money_in')).toHaveLength(0);
    });

    it('a pending credit says nothing, then exactly one notice when it completes', async () => {
      const ada = await addUser();
      const customerReference = ref('SEND');
      const id = await credit(ada, 'transfer', {
        status: 'pending',
        customerReference,
      });
      await notice.sweep();
      expect(await noteOf(ada, 'money_in')).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(0);
      await ledger.record(
        movement(ada, 'transfer', {
          status: 'completed',
          customerReference,
          source: 'webhook',
        }),
      );
      await notice.sweep();
      await notice.sweep();
      const notes = await noteOf(ada, 'money_in');
      expect(notes).toHaveLength(1);
      expect(notes[0].target?.targetId).toBe(id);
    });

    it('never names the sender of earnings or a refund, and says "a WAWU user" for a person with no name', async () => {
      const ada = await addUser();
      await credit(ada, 'earning', {
        counterparty: {
          kind: 'wawu_user',
          name: 'A Buyer',
          wawuUserId: randomUUID(),
          accountNumber: '8099999999',
        },
      });
      await credit(ada, 'refund', {
        counterparty: { kind: 'wawu', name: 'WAWU' },
      });
      await credit(ada, 'transfer', {
        counterparty: {
          kind: 'wawu_user',
          name: null,
          wawuUserId: randomUUID(),
        },
      });
      await notice.sweep();
      const bodies = (await noteOf(ada, 'money_in')).map((n) => n.body).sort();
      expect(bodies).toEqual(
        [
          'You received ₦5,000 from a WAWU user.',
          'You received ₦5,000 in earnings.',
          'You received a refund of ₦5,000.',
        ].sort(),
      );
    });

    it("tells a points cash-out as the person's points", async () => {
      const ada = await addUser();
      await credit(ada, 'earning', {
        link: { kind: 'points_cash_out', targetId: 'c1', title: '500 points' },
        counterparty: { kind: 'wawu', name: null },
      });
      await notice.sweep();
      const [n] = await noteOf(ada, 'money_in');
      expect(n.body).toBe('You received ₦5,000 from your points.');
    });

    it("a server tells its own provider's credits of every category only", async () => {
      const ada = await addUser();
      const id = await credit(ada, 'transfer');
      await prisma.fintavaLedgerEntry.update({
        where: { id },
        data: { provider: 'nuvion' },
      });
      expect(await processOf('fintava').noticeEntry(id)).toBe('skipped');
      expect(await processOf('nuvion').noticeEntry(id)).toBe('sent');
      expect(await processOf('nuvion').noticeEntry(id)).toBe('skipped');
      expect(await noteOf(ada, 'money_in')).toHaveLength(1);
    });

    it("a hold's release and refund, as the hold writes them, are told like any other earning and refund", async () => {
      // The payee's side of a release and the payer's side of a refund are `in`
      // rows on their wallets; the merchant side is WAWU's and is not told.
      const payee = await addUser();
      const payer = await addUser();
      const merchantAccount = `M${RUN}${(seq += 1)}`;
      const release = ref('REL');
      const back = ref('BACK');
      for (const [person, category, customerReference] of [
        [payee, 'earning', release],
        [payer, 'refund', back],
      ] as const) {
        await ledger.record({
          wallet: { kind: 'merchant', accountNumber: merchantAccount },
          direction: 'out',
          status: 'completed',
          category,
          amountKobo: 85_000,
          counterparty: {
            kind: 'wawu_user',
            name: null,
            wawuUserId: person.wawuUserId,
            accountNumber: person.accountNumber,
          },
          references: { customerReference },
          source: 'send',
        });
        await ledger.record(
          movement(person, category, {
            kobo: 85_000,
            customerReference,
            counterparty:
              category === 'earning'
                ? {
                    kind: 'wawu_user',
                    name: null,
                    wawuUserId: payer.wawuUserId,
                  }
                : { kind: 'wawu', name: null },
          }),
        );
      }
      try {
        await notice.sweep();
        expect((await noteOf(payee, 'money_in'))[0].body).toBe(
          'You received ₦850 in earnings.',
        );
        expect((await noteOf(payer, 'money_in'))[0].body).toBe(
          'You received a refund of ₦850.',
        );
        const merchantRows = await prisma.fintavaLedgerEntry.findMany({
          where: { accountNumber: merchantAccount },
          select: { id: true },
        });
        expect(merchantRows).toHaveLength(2);
        expect(
          await prisma.moneyInNotice.count({
            where: { entryId: { in: merchantRows.map((r) => r.id) } },
          }),
        ).toBe(0);
      } finally {
        await prisma.fintavaLedgerEntry.deleteMany({
          where: { accountNumber: merchantAccount },
        });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('"Money in" in Z3 mutes the notice of every credit', () => {
    it('writes nothing for any category, marks them muted, and does not bring them back', async () => {
      const ada = await addUser({ moneyIn: false });
      await credit(ada, 'transfer');
      await credit(ada, 'earning');
      await credit(ada, 'refund');
      expect(await notice.sweep()).toMatchObject({ sent: 0, muted: 3 });
      expect(await noteOf(ada, 'money_in')).toHaveLength(0);
      expect((await marksOf(ada)).map((m) => m.outcome)).toEqual([
        'muted',
        'muted',
        'muted',
      ]);
      await prisma.notificationSettings.update({
        where: { userWawuId: ada.wawuUserId },
        data: { moneyIn: true },
      });
      await notice.sweep();
      expect(await noteOf(ada, 'money_in')).toHaveLength(0);
      await credit(ada, 'transfer');
      await notice.sweep();
      expect(await noteOf(ada, 'money_in')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('capability 3: a reversed credit is followed by a correction', () => {
    const reverse = (
      person: Person,
      category: Source,
      customerReference: string,
    ) =>
      ledger.record(
        movement(person, category, {
          status: 'reversed',
          customerReference,
          source: 'webhook',
        }),
      );

    it.each([
      ['transfer', 'The ₦5,000 you received from Tolu B. was reversed.'],
      ['earning', 'The ₦5,000 in earnings was reversed.'],
      ['refund', 'The ₦5,000 refund was reversed.'],
      [
        'top_up',
        'The ₦5,000 you received from Ada Obi (****1291) was reversed.',
      ],
    ] as const)(
      'a %s taken back after it was told is corrected once, and the notice that stood is not touched',
      async (category, words) => {
        const ada = await addUser();
        const customerReference = ref('REV');
        const id = await credit(ada, category, { customerReference });
        await notice.sweep();
        const [first] = await noteOf(ada, 'money_in');
        expect(first.target?.targetId).toBe(id);
        expect(await noticeCorrections(ada)).toHaveLength(0);

        // The ledger moves the row forward to reversed (a replay of the old
        // credit afterwards cannot bring it back).
        const r = await reverse(ada, category, customerReference);
        expect(r.created).toBe(false);
        expect(
          (await prisma.fintavaLedgerEntry.findUniqueOrThrow({ where: { id } }))
            .status,
        ).toBe('reversed');

        // WALLET-10's pass still tells nothing, and a reversed row is not "told".
        expect(await notice.sweep()).toMatchObject({ sent: 0 });
        expect(await notice.sweepCorrections()).toEqual({
          corrected: 1,
          skipped: 0,
          failed: 0,
        });
        const fixes = await noticeCorrections(ada);
        expect(fixes).toHaveLength(1);
        expect(fixes[0]).toMatchObject({
          title: 'Money reversed',
          body: words,
          tone: 'warning',
          amount: null,
          read: false,
        });
        expect(fixes[0].target).toMatchObject({
          targetKind: 'transaction',
          targetId: id,
        });
        const [mark] = await marksOf(ada);
        expect(mark).toMatchObject({
          entryId: id,
          outcome: 'sent',
          notificationId: first.id,
          correctionNotificationId: fixes[0].id,
        });
        expect(mark.correctedAt).toBeInstanceOf(Date);

        // Once, however many times and by whom.
        const none = { corrected: 0, skipped: 0, failed: 0 };
        expect(await notice.sweepCorrections()).toEqual(none);
        expect(await processOf().sweepCorrections()).toEqual(none);
        expect(await notice.correctEntry(id)).toBe('skipped');
        await reverse(ada, category, customerReference);
        expect(await notice.sweepCorrections()).toEqual(none);
        expect(await noticeCorrections(ada)).toHaveLength(1);
        expect(await noteOf(ada, 'money_in')).toHaveLength(1);
      },
    );

    const noticeCorrections = (person: Person) =>
      noteOf(person, 'money_in_reversed');

    it('three processes correcting the same credit at the same moment write one notice', async () => {
      const ada = await addUser();
      const customerReference = ref('REV');
      const id = await credit(ada, 'transfer', { customerReference });
      await notice.sweep();
      await reverse(ada, 'transfer', customerReference);
      const results = await Promise.all([
        processOf().correctEntry(id),
        processOf().correctEntry(id),
        processOf().correctEntry(id),
      ]);
      expect(results.filter((r) => r === 'corrected')).toHaveLength(1);
      expect(await noticeCorrections(ada)).toHaveLength(1);
    });

    it('says nothing about a credit nobody was told about: muted, not yet told, or reversed before it was told', async () => {
      const ada = await addUser({ moneyIn: false });
      const customerReference = ref('REV');
      await credit(ada, 'transfer', { customerReference });
      await notice.sweep();
      expect((await marksOf(ada))[0].outcome).toBe('muted');
      await reverse(ada, 'transfer', customerReference);
      expect(await notice.sweepCorrections()).toMatchObject({ corrected: 0 });
      expect(await noticeCorrections(ada)).toHaveLength(0);

      const bayo = await addUser();
      const second = ref('REV');
      const id = await credit(bayo, 'earning', { customerReference: second });
      await reverse(bayo, 'earning', second);
      await notice.sweep();
      expect(await notice.noticeEntry(id)).toBe('skipped');
      expect(await notice.correctEntry(id)).toBe('skipped');
      expect(await noteOf(bayo, 'money_in')).toHaveLength(0);
      expect(await noticeCorrections(bayo)).toHaveLength(0);
      expect(await marksOf(bayo)).toHaveLength(0);
    });

    it("the list always carries the correction, and 'Money in' off only silences its push", async () => {
      const ada = await addUser();
      const customerReference = ref('REV');
      const id = await credit(ada, 'transfer', { customerReference });
      await notice.sweep();
      // The person switches "Money in" off after being told.
      await prisma.notificationSettings.create({
        data: { userWawuId: ada.wawuUserId, moneyIn: false },
      });
      await reverse(ada, 'transfer', customerReference);
      expect(await notice.sweepCorrections()).toMatchObject({ corrected: 1 });
      expect(await noticeCorrections(ada)).toHaveLength(1);
      expect((await noteOf(ada, 'money_in'))[0].target?.targetId).toBe(id);
    });

    it('a notice that could not be written leaves no mark and is tried again', async () => {
      const ada = await addUser();
      const customerReference = ref('REV');
      const id = await credit(ada, 'refund', { customerReference });
      await notice.sweep();
      await reverse(ada, 'refund', customerReference);
      const spy = jest.spyOn(notifications, 'emit').mockResolvedValueOnce(null);
      try {
        expect(await notice.correctEntry(id)).toBe('failed');
      } finally {
        spy.mockRestore();
      }
      expect(await noticeCorrections(ada)).toHaveLength(0);
      expect((await marksOf(ada))[0].correctedAt).toBeNull();
      // The failed row rests inside this process; a new process tries at once.
      expect(await processOf().correctEntry(id)).toBe('corrected');
      expect(await noticeCorrections(ada)).toHaveLength(1);
    });

    it('a failed row does not hold the others back', async () => {
      const ada = await addUser();
      const bad = ref('REV');
      const good = ref('REV');
      const badId = await credit(ada, 'transfer', { customerReference: bad });
      const goodId = await credit(ada, 'refund', { customerReference: good });
      await notice.sweep();
      await reverse(ada, 'transfer', bad);
      await reverse(ada, 'refund', good);
      const real = notifications.emit.bind(notifications);
      const spy = jest
        .spyOn(notifications, 'emit')
        .mockImplementation((event, client) =>
          'about' in event && event.about?.target?.id === badId
            ? Promise.resolve(null)
            : real(event, client),
        );
      let report;
      try {
        report = await notice.sweepCorrections();
      } finally {
        spy.mockRestore();
      }
      expect(report).toMatchObject({ corrected: 1, failed: 1 });
      const fixes = await noticeCorrections(ada);
      expect(fixes.map((f) => f.target?.targetId)).toEqual([goodId]);
    });
  });

  // -------------------------------------------------------------------------
  describe('what the phone and the list get', () => {
    it('hands the phone the transaction to open for the notice and for its correction, and a muted push stays silent', async () => {
      const ada = await addUser();
      const phone = `ExponentPushToken[${RUN}-ada]`;
      await tokens.register(ada.wawuUserId, {
        expoPushToken: phone,
        platform: 'ios',
      });
      await new Promise((r) => setTimeout(r, 10));
      const customerReference = ref('PUSH');
      const id = await credit(ada, 'transfer', { customerReference });
      await notice.sweep();
      await sender.runOnce();
      const [note] = await noteOf(ada, 'money_in');
      const first = stand.sentMessages().filter((m) => m.to === phone);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        title: 'Money received',
        body: 'You received ₦5,000 from Tolu B.',
      });
      expect(first[0].data).toEqual({
        notificationId: note.id,
        kind: 'money_in',
        target: { kind: 'transaction', id },
      });

      await ledger.record(
        movement(ada, 'transfer', {
          status: 'reversed',
          customerReference,
          source: 'webhook',
        }),
      );
      await notice.sweepCorrections();
      await sender.runOnce();
      await sender.runOnce();
      const all = stand.sentMessages().filter((m) => m.to === phone);
      expect(all).toHaveLength(2);
      expect(all[1]).toMatchObject({
        title: 'Money reversed',
        body: 'The ₦5,000 you received from Tolu B. was reversed.',
      });
      expect(all[1].data).toMatchObject({
        kind: 'money_in_reversed',
        target: { kind: 'transaction', id },
      });

      // The same, with "Money in" off at the moment of the correction: the list
      // has it, the phone does not buzz.
      const bayo = await addUser();
      const phone2 = `ExponentPushToken[${RUN}-bayo]`;
      await tokens.register(bayo.wawuUserId, {
        expoPushToken: phone2,
        platform: 'android',
      });
      await new Promise((r) => setTimeout(r, 10));
      const second = ref('PUSH');
      await credit(bayo, 'refund', { customerReference: second });
      await notice.sweep();
      await sender.runOnce();
      await prisma.notificationSettings.create({
        data: { userWawuId: bayo.wawuUserId, moneyIn: false },
      });
      await ledger.record(
        movement(bayo, 'refund', {
          status: 'reversed',
          customerReference: second,
          source: 'webhook',
        }),
      );
      await notice.sweepCorrections();
      await sender.runOnce();
      expect(await noteOf(bayo, 'money_in_reversed')).toHaveLength(1);
      expect(stand.sentMessages().filter((m) => m.to === phone2)).toHaveLength(
        1,
      );
    });

    it("opens from the app's list: the target is the transaction, for its owner only", async () => {
      const ada = await addUser();
      const id = await credit(ada, 'top_up');
      await notice.sweep();
      const page = await feed.list(ada.wawuUserId, 'all', undefined, 20);
      const item = page.items.find((i) => i.target?.id === id);
      expect(item).toMatchObject({
        kind: 'money_in',
        category: 'money',
        target: { kind: 'transaction', id, title: null, deadlineAt: null },
        actor: null,
      });
      // The same notification read by someone else resolves no transaction.
      const [note] = await noteOf(ada, 'money_in');
      const bayo = await addUser();
      await prisma.notification.update({
        where: { id: note.id },
        data: { userWawuId: bayo.wawuUserId },
      });
      const theirs = await feed.list(bayo.wawuUserId, 'all', undefined, 20);
      expect(theirs.items.find((i) => i.id === note.id)?.target).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the migration', () => {
    it('marks the credits of the new categories already there as not news, leaves a pending one, and tells nobody of an old reversal', async () => {
      const ada = await addUser();
      const old = {
        transfer: await credit(ada, 'transfer'),
        earning: await credit(ada, 'earning'),
        refund: await credit(ada, 'refund'),
      };
      const pending = await credit(ada, 'transfer', { status: 'pending' });
      // A merchant row is not a person's.
      const merchant = await prisma.fintavaLedgerEntry.create({
        data: {
          walletKind: 'merchant',
          wawuUserId: null,
          accountNumber: `M${RUN}${(seq += 1)}`,
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 5_000n,
          totalKobo: 5_000n,
          source: 'webhook',
          occurredAt: new Date(),
          provider: 'fintava',
        },
      });
      // A credit told and since reversed, before the migration.
      const bayo = await addUser();
      const customerReference = ref('OLD');
      const toldThenReversed = await credit(bayo, 'transfer', {
        customerReference,
      });
      await notice.noticeEntry(toldThenReversed);
      await ledger.record(
        movement(bayo, 'transfer', {
          status: 'reversed',
          customerReference,
          source: 'webhook',
        }),
      );
      try {
        await prisma.$executeRawUnsafe(backfillOne());
        await prisma.$executeRawUnsafe(backfillTwo());
        const marks = await marksOf(ada);
        expect(marks.map((m) => [m.entryId, m.outcome]).sort()).toEqual(
          Object.values(old)
            .map((id) => [id, 'before'])
            .sort(),
        );
        expect(marks.find((m) => m.entryId === pending)).toBeUndefined();
        expect(
          await prisma.moneyInNotice.count({ where: { entryId: merchant.id } }),
        ).toBe(0);
        await notice.sweep();
        expect(await noteOf(ada, 'money_in')).toHaveLength(0);

        const [mark] = await marksOf(bayo);
        expect(mark.outcome).toBe('sent');
        expect(mark.correctedAt).toBeInstanceOf(Date);
        expect(mark.correctionNotificationId).toBeNull();
        expect(await notice.sweepCorrections()).toMatchObject({ corrected: 0 });
        expect(await noteOf(bayo, 'money_in_reversed')).toHaveLength(0);

        // Replaying the migration changes nothing.
        await prisma.$executeRawUnsafe(backfillOne());
        await prisma.$executeRawUnsafe(backfillTwo());
        expect(await marksOf(ada)).toHaveLength(3);
      } finally {
        await prisma.fintavaLedgerEntry.delete({ where: { id: merchant.id } });
      }
    });

    it('a deleted ledger row takes its mark with it', async () => {
      const ada = await addUser();
      const id = await credit(ada, 'refund');
      await notice.sweep();
      expect(await marksOf(ada)).toHaveLength(1);
      await prisma.fintavaLedgerEntry.delete({ where: { id } });
      expect(await marksOf(ada)).toHaveLength(0);
    });
  });
});
