import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../../common/auth/wawu-auth.module';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../../fintava/webhook/fintava-signature';
import { FintavaWebhookModule } from '../../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { NuvionInflowRecorder } from '../../../nuvion/handlers/inflows';
import { readNuvionTransfer } from '../../../nuvion/nuvion-ledger-delivery';
import { NotificationModule } from '../../../notification/notification.module';
import { NotificationService } from '../../../notification/notification.service';
import { BlockedAccountService } from '../../../blocked-account/blocked-account.service';
import { ExpoPushClient } from '../../../push/expo-push.client';
import { PushModule } from '../../../push/push.module';
import { PushSenderService } from '../../../push/push-sender.service';
import { PushTokenService } from '../../../push/push-token.service';
import { ExpoStandIn } from '../../../push/tests/expo-stand-in';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { LedgerConsumerService } from '../../ledger/ledger-consumer.service';
import { LedgerModule } from '../../ledger/ledger.module';
import { LedgerService } from '../../ledger/ledger.service';
import type { TransferStatus } from '../../money-view.type';
import { MoneyInNoticeModule } from '../money-in-notice.module';
import { MoneyInNoticeService } from '../money-in-notice.service';

/**
 * Money in, told once (task WALLET-10) over its real inputs: a delivery signed
 * with a local secret and posted to MONEY-07's real route (there is no tunnel,
 * R-25), stored, read by the ledger's consumer into a ledger row, and told by
 * this task's sweep, against a real database, with the real
 * NotificationService and, for the phone, the real push sender talking to the
 * Expo stand-in (src/push/tests/expo-stand-in.ts). An `account_funded`
 * delivery is trusted alone by the ledger (MONEY-10), so no Fintava call is
 * made and none is stood in.
 *
 * Every row a spec makes belongs to its own people, found by their ids, and
 * everything is deleted at the end.
 */

const RUN = `w10${Date.now().toString(36)}`;
const SECRET = 'whsec_local_w10_Xk3Qp8Lm2Zr6Td9Vb';
const PATH = '/api/hub/webhooks/fintava';

class QuietLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

/** The part of the migration that marks the credits already there. */
function backfillSql(): string {
  const file = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
      '20261021210000_money_in_notices',
      'migration.sql',
    ),
    'utf8',
  );
  const at = file.indexOf('INSERT INTO "MoneyInNotice"');
  expect(at).toBeGreaterThan(0);
  return file.slice(at);
}

describe('Money in, told once (WALLET-10)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let consumer: LedgerConsumerService;
  let notice: MoneyInNoticeService;
  let notifications: NotificationService;
  let provider: WalletProvider;
  let config: ConfigService;
  let sender: PushSenderService;
  let tokens: PushTokenService;
  let blocks: BlockedAccountService;
  const stand = new ExpoStandIn();
  const logger = new QuietLogger();
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

  async function addUser(
    o: {
      moneyIn?: boolean | null;
      provider?: 'fintava' | 'nuvion' | null;
    } = {},
  ) {
    const wawuUserId = randomUUID();
    const customerId = randomUUID();
    seq += 1;
    const accountNumber = `8${String(Date.now()).slice(-7)}${String(seq % 100).padStart(2, '0')}`;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId,
        customerId,
        walletId: randomUUID(),
        accountNumber,
        ...(o.provider !== undefined ? { provider: o.provider } : {}),
      },
    });
    if (o.moneyIn !== undefined) {
      await prisma.notificationSettings.create({
        data: { userWawuId: wawuUserId, moneyIn: o.moneyIn },
      });
    }
    users.push(wawuUserId);
    return { wawuUserId, customerId, accountNumber };
  }
  type Person = Awaited<ReturnType<typeof addUser>>;

  /** `account_funded`, the documented field set, for this person. */
  function funded(
    to: Person,
    o: {
      reference: string;
      amount?: string;
      status?: string;
      name?: string | null;
      sender?: string | null;
      session?: string;
      channel?: string;
    },
  ): string {
    const data: Record<string, unknown> = {
      userId: to.customerId,
      amount: o.amount ?? '100.00',
      reference: o.reference,
      senderBankSortcode: '000014',
      sessionID: o.session ?? `S-${o.reference}`,
      channelCode: o.channel ?? '3',
      status: o.status ?? 'success',
      beneficiaryAccountName: 'Joe Services Limited',
      beneficiaryAccountNumber: to.accountNumber,
    };
    if (o.name !== null) data.accountName = o.name ?? 'John Doe';
    if (o.sender !== null) data.accountNumber = o.sender ?? '0865231291';
    return JSON.stringify({ event: 'account_funded', data }, null, 2);
  }

  /** Posts to the real route, signed with the local secret; returns the stored event id. */
  async function deliver(text: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set(FINTAVA_SIGNATURE_HEADER, signFintavaBody(SECRET, Buffer.from(text)))
      .send(text);
    expect(res.status).toBe(200);
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "FintavaWebhookEvent"
       WHERE position(convert_to(${text}, 'UTF8') in "rawBody") > 0
         AND "rawBody" = convert_to(${text}, 'UTF8')`;
    expect(ids).toHaveLength(1);
    return ids[0].id;
  }

  /** Post it, and let the ledger's consumer read it, as the sweep would. */
  async function arrive(text: string) {
    const id = await deliver(text);
    await consumer.consume(id);
    return id;
  }

  const rowsOf = (person: Person) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { wawuUserId: person.wawuUserId },
      orderBy: { createdAt: 'asc' },
    });
  const notesOf = (person: Person) =>
    prisma.notification.findMany({
      where: { userWawuId: person.wawuUserId, kind: 'money_in' },
      orderBy: { createdAt: 'asc' },
    });
  const marksOf = (person: Person) =>
    prisma.moneyInNotice.findMany({
      where: { entry: { wawuUserId: person.wawuUserId } },
      orderBy: { createdAt: 'asc' },
    });

  /** A credited ledger row written the way the ledger writes one. */
  async function credit(
    person: Person,
    o: {
      kobo?: number;
      status?: TransferStatus;
      name?: string | null;
      number?: string | null;
      category?: 'top_up' | 'transfer' | 'earning';
      direction?: 'in' | 'out';
      provider?: 'fintava' | 'nuvion' | null;
    } = {},
  ) {
    const r = await ledger.record({
      wallet: {
        kind: 'user',
        wawuUserId: person.wawuUserId,
        accountNumber: person.accountNumber,
      },
      direction: o.direction ?? 'in',
      status: o.status ?? 'completed',
      category: o.category ?? 'top_up',
      amountKobo: o.kobo ?? 10_000,
      counterparty: {
        kind: 'bank_account',
        name: o.name === undefined ? 'John Doe' : o.name,
        accountNumber: o.number === undefined ? '0865231291' : o.number,
        bankCode: '000014',
      },
      references: { delivery: [ref('CRED')] },
      source: 'webhook',
    });
    if (o.provider !== undefined) {
      await prisma.fintavaLedgerEntry.update({
        where: { id: r.entryId },
        data: { provider: o.provider },
      });
    }
    return r.entryId;
  }

  beforeAll(async () => {
    await stand.start();
    const env = {
      FINTAVA_WEBHOOK_SECRET: SECRET,
      PUSH_ENABLED: 'true',
      EXPO_PUSH_BASE_URL: stand.baseUrl,
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        FintavaWebhookModule,
        LedgerModule,
        MoneyInNoticeModule,
        PushModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
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
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
    consumer = moduleRef.get(LedgerConsumerService);
    notice = moduleRef.get(MoneyInNoticeService);
    notifications = moduleRef.get(NotificationService);
    provider = moduleRef.get(WALLET_PROVIDER);
    config = moduleRef.get(ConfigService);
    sender = moduleRef.get(PushSenderService);
    tokens = moduleRef.get(PushTokenService);
    blocks = moduleRef.get(BlockedAccountService);
    expect(provider.name).toBe('fintava');
    // Credits another suite left in this database are not news to this one.
    await prisma.$executeRawUnsafe(backfillSql());
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
    await prisma.$executeRaw`
      DELETE FROM "FintavaWebhookEvent"
       WHERE position(convert_to(${RUN}, 'UTF8') in "rawBody") > 0`;
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

  beforeEach(() => {
    stand.reset();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('capability 1: a transfer into the account is in the history and tells the person once', () => {
    it('a signed inbound credit becomes one ledger row and one notification, whatever the sweeps do after', async () => {
      const ada = await addUser();
      await arrive(
        funded(ada, {
          reference: ref('F1'),
          amount: '100.00',
          name: 'John Doe',
          sender: '0865231291',
        }),
      );

      const rows = await rowsOf(ada);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        walletKind: 'user',
        direction: 'in',
        category: 'top_up',
        status: 'completed',
        provider: 'fintava',
        counterpartyName: 'John Doe',
        counterpartyAccountNumber: '0865231291',
      });
      expect(rows[0].amountKobo).toBe(10_000n);
      expect(await notesOf(ada)).toHaveLength(0);

      const first = await notice.sweep();
      expect(first.sent).toBe(1);

      const notes = await notesOf(ada);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        title: 'Money received',
        body: 'You received ₦100 from John Doe (****1291).',
        tone: 'success',
        amount: 100,
        read: false,
        actionHref: null,
      });
      const marks = await marksOf(ada);
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({
        entryId: rows[0].id,
        outcome: 'sent',
        notificationId: notes[0].id,
      });

      // Nothing more, however many times it is looked at again: a told row is
      // not even read again (no skip, no failure, no second attempt).
      const none = { sent: 0, muted: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < 3; i += 1) expect(await notice.sweep()).toEqual(none);
      expect(await processOf().sweep()).toEqual(none);
      expect(await notice.noticeEntry(rows[0].id)).toBe('skipped');
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await marksOf(ada)).toHaveLength(1);
      expect(await rowsOf(ada)).toHaveLength(1);
    });

    it('is told from the ledger row, not the delivery: the delivery being marked again or failing changes nothing', async () => {
      const ada = await addUser();
      const event = await arrive(funded(ada, { reference: ref('F2') }));
      await prisma.fintavaWebhookEvent.update({
        where: { id: event },
        data: { processingStatus: 'failed', note: 'a reviewer touched it' },
      });
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
      await prisma.fintavaWebhookEvent.update({
        where: { id: event },
        data: { processingStatus: 'pending' },
      });
      await consumer.consume(event);
      await notice.sweep();
      expect(await rowsOf(ada)).toHaveLength(1);
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('names no sender when the provider gave no name, and never a bare number', async () => {
      const ada = await addUser();
      await arrive(
        funded(ada, {
          reference: ref('F3'),
          amount: '5000.00',
          name: null,
          sender: '0865231291',
        }),
      );
      await notice.sweep();
      const [note] = await notesOf(ada);
      expect(note.body).toBe('You received ₦5,000 by bank transfer.');
      expect(note.body).not.toContain('1291');
    });

    it('says the kobo and leaves the whole-naira column empty for a credit with kobo in it', async () => {
      const ada = await addUser();
      await arrive(
        funded(ada, {
          reference: ref('F4'),
          amount: '1250.50',
          name: 'Ada Obi',
        }),
      );
      await notice.sweep();
      const [note] = await notesOf(ada);
      expect(note.body).toBe('You received ₦1,250.50 from Ada Obi (****1291).');
      expect(note.amount).toBeNull();
      const [row] = await rowsOf(ada);
      expect(row.amountKobo).toBe(125_050n);
    });

    it('tells the person whose account it is and nobody else', async () => {
      const ada = await addUser();
      const bayo = await addUser();
      await arrive(funded(ada, { reference: ref('F5') }));
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await notesOf(bayo)).toHaveLength(0);
      expect(await rowsOf(bayo)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('replays and out-of-order deliveries', () => {
    it('a replayed delivery, and the same credit delivered again in other bytes, are one row and one notification', async () => {
      const ada = await addUser();
      const reference = ref('R1');
      const body = funded(ada, { reference });
      const id = await arrive(body);
      expect(await deliver(body)).toBe(id); // the route keeps one row for the same bytes
      await consumer.consume(id);
      // The same credit as another delivery: other bytes, the same reference.
      await arrive(funded(ada, { reference, channel: '7' }));
      expect(await rowsOf(ada)).toHaveLength(1);
      await notice.sweep();
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await marksOf(ada)).toHaveLength(1);
    });

    it('success then pending: the row stays completed and is told once', async () => {
      const ada = await addUser();
      const reference = ref('O1');
      await arrive(funded(ada, { reference, status: 'success' }));
      await arrive(funded(ada, { reference, status: 'PENDING' }));
      const [row] = await rowsOf(ada);
      expect(row.status).toBe('completed');
      await notice.sweep();
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('pending then success: nothing while it is pending, then exactly one when it completes', async () => {
      const ada = await addUser();
      const reference = ref('O2');
      await arrive(funded(ada, { reference, status: 'PENDING' }));
      const [pending] = await rowsOf(ada);
      expect(pending.status).toBe('pending');
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(0);
      await arrive(funded(ada, { reference, status: 'success' }));
      const [row] = await rowsOf(ada);
      expect(row.id).toBe(pending.id);
      expect(row.status).toBe('completed');
      await notice.sweep();
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('two credits delivered in the reverse order are two rows and two notifications, each with its own amount', async () => {
      const ada = await addUser();
      const first = funded(ada, {
        reference: ref('O3a'),
        amount: '100.00',
        name: 'First Payer',
      });
      const second = funded(ada, {
        reference: ref('O3b'),
        amount: '250.50',
        name: 'Second Payer',
      });
      const idFirst = await deliver(first);
      const idSecond = await deliver(second);
      await consumer.consume(idSecond);
      await consumer.consume(idFirst);
      expect(await rowsOf(ada)).toHaveLength(2);
      await notice.sweep();
      const bodies = (await notesOf(ada)).map((n) => n.body).sort();
      expect(bodies).toEqual([
        'You received ₦100 from First Payer (****1291).',
        'You received ₦250.50 from Second Payer (****1291).',
      ]);
      expect(await marksOf(ada)).toHaveLength(2);
    });

    it('a credit recalled after it was told is not told again, and one reversed before it was told never is', async () => {
      const ada = await addUser();
      const told = await credit(ada, { kobo: 20_000 });
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
      await prisma.fintavaLedgerEntry.update({
        where: { id: told },
        data: { status: 'reversed', reversedAt: new Date() },
      });
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);

      const bayo = await addUser();
      const untold = await credit(bayo, { kobo: 20_000 });
      await prisma.fintavaLedgerEntry.update({
        where: { id: untold },
        data: { status: 'reversed', reversedAt: new Date() },
      });
      await notice.sweep();
      expect(await notice.noticeEntry(untold)).toBe('skipped');
      expect(await notesOf(bayo)).toHaveLength(0);
      expect(await marksOf(bayo)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('two Hub processes', () => {
    it('forty credits swept by three processes at once are forty notifications, one each', async () => {
      const people = await Promise.all(
        Array.from({ length: 5 }, () => addUser()),
      );
      const entries: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        entries.push(
          await credit(people[i % 5], { kobo: 1_000 + i, name: `Payer ${i}` }),
        );
      }
      const processes = [notice, processOf(), processOf()];
      const reports = [];
      for (let round = 0; round < 2; round += 1) {
        reports.push(...(await Promise.all(processes.map((p) => p.sweep()))));
      }
      // Rows another process held at that moment are left for the next pass.
      for (let i = 0; i < 2; i += 1) {
        await Promise.all(processes.map((p) => p.sweep()));
      }
      const totalSent = reports.reduce((n, r) => n + r.sent, 0);
      expect(totalSent).toBeLessThanOrEqual(40);
      for (const person of people) {
        const rows = await rowsOf(person);
        expect(rows).toHaveLength(8);
        expect(await notesOf(person)).toHaveLength(8);
        expect(await marksOf(person)).toHaveLength(8);
        const bodies = (await notesOf(person)).map((n) => n.body);
        expect(new Set(bodies).size).toBe(8);
      }
    });

    it('the same row told by three processes at the same moment is one notification', async () => {
      for (let round = 0; round < 6; round += 1) {
        const ada = await addUser();
        const entry = await credit(ada);
        const outcomes = await Promise.all([
          notice.noticeEntry(entry),
          processOf().noticeEntry(entry),
          processOf().noticeEntry(entry),
        ]);
        expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
        expect(outcomes.every((o) => o === 'sent' || o === 'skipped')).toBe(
          true,
        );
        expect(await notesOf(ada)).toHaveLength(1);
        expect(await marksOf(ada)).toHaveLength(1);
      }
    });

    it('a row a ledger writer holds is not waited for, and is told on the next pass', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const gotLock = new Promise<void>((r) => (locked = r));
      const writer = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "FintavaLedgerEntry" WHERE "id" = ${entry} FOR UPDATE`;
        locked();
        await held;
      });
      await gotLock;
      const started = Date.now();
      expect(await notice.noticeEntry(entry)).toBe('skipped');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await notesOf(ada)).toHaveLength(0);
      release();
      await writer;
      expect(await notice.noticeEntry(entry)).toBe('sent');
      expect(await notesOf(ada)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('a stop between the row and the notification', () => {
    it('a stop after the notification was written and before the mark undoes both, and the next pass tells it once', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      const real = notifications.emit.bind(notifications);
      jest
        .spyOn(notifications, 'emit')
        .mockImplementationOnce(async (event, client) => {
          const row = await real(event, client);
          expect(row).not.toBeNull();
          throw new Error('the process stopped here');
        });
      expect(await notice.noticeEntry(entry)).toBe('failed');
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(0);

      // A new process (the mock is used up): the row is still waiting.
      const restarted = processOf();
      expect(await restarted.noticeEntry(entry)).toBe('sent');
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await marksOf(ada)).toHaveLength(1);
      expect(await processOf().sweep()).toMatchObject({ sent: 0 });
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('a stop after the commit and before any push leaves one notification, and one push when the sender runs', async () => {
      const ada = await addUser();
      const phone = `ExponentPushToken[w10-${RUN}-${(seq += 1)}]`;
      await tokens.register(ada.wawuUserId, {
        expoPushToken: phone,
        platform: 'android',
      });
      await new Promise((r) => setTimeout(r, 10));
      const entry = await credit(ada, { kobo: 450_000, name: 'Ngozi Eze' });
      expect(await notice.noticeEntry(entry)).toBe('sent');
      // The process stops now: a new one finds the mark and tells nothing.
      expect(await processOf().sweep()).toMatchObject({ sent: 0 });
      expect(await processOf().noticeEntry(entry)).toBe('skipped');
      const [note] = await notesOf(ada);

      const pass = await sender.runOnce();
      expect(pass.sent).toBeGreaterThanOrEqual(1);
      const mine = stand.sentMessages().filter((m) => m.to === phone);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        title: 'Money received',
        body: 'You received ₦4,500 from Ngozi Eze (****1291).',
      });
      expect(mine[0].data).toEqual({
        notificationId: note.id,
        kind: 'money_in',
      });
      // Another pass, another process: no second push for the same notification.
      await sender.runOnce();
      await new PushSenderService(
        prisma,
        notifications,
        new ExpoPushClient(),
        blocks,
      ).runOnce();
      expect(stand.sentMessages().filter((m) => m.to === phone)).toHaveLength(
        1,
      );
    });

    it('if another process marks the row after this one read it, the key refuses the second mark and this transaction (its notification with it) is undone', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      const real = notifications.emit.bind(notifications);
      jest
        .spyOn(notifications, 'emit')
        .mockImplementationOnce(async (event, client) => {
          const row = await real(event, client);
          // The other process, on its own connection, marks the same row first.
          await prisma.moneyInNotice.create({
            data: { entryId: entry, outcome: 'sent', notificationId: 'theirs' },
          });
          return row;
        });
      expect(await notice.noticeEntry(entry)).toBe('skipped');
      expect(await notesOf(ada)).toHaveLength(0);
      const marks = await marksOf(ada);
      expect(marks).toHaveLength(1);
      expect(marks[0].notificationId).toBe('theirs');
    });

    it('when the notification cannot be written (not the switch), nothing is marked and the pass fails the row, then tells it', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      jest.spyOn(notifications, 'emit').mockResolvedValueOnce(null);
      expect(await notice.noticeEntry(entry)).toBe('failed');
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(0);
      // The row rests (1 minute, in this process); another process tells it now.
      expect(await processOf().noticeEntry(entry)).toBe('sent');
      expect(await notesOf(ada)).toHaveLength(1);
      // The same process, after its rest, would find it marked.
      expect(
        await notice.sweep(new Date(Date.now() + 2 * 60_000)),
      ).toMatchObject({ sent: 0 });
    });

    it('a sweep that fails one row goes on to the rest, and rests that row', async () => {
      const ada = await addUser();
      const bayo = await addUser();
      const bad = await credit(ada, { kobo: 11_100 });
      const good = await credit(bayo, { kobo: 22_200 });
      const real = notifications.emit.bind(notifications);
      jest.spyOn(notifications, 'emit').mockImplementation((event, client) => {
        if (event.userWawuId === ada.wawuUserId) {
          throw new Error('this one cannot be written');
        }
        return real(event, client);
      });
      const first = await notice.sweep();
      expect(first.failed).toBeGreaterThanOrEqual(1);
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await notesOf(bayo)).toHaveLength(1);
      jest.restoreAllMocks();
      // At rest: the next pass of this process leaves the failed row alone.
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      // After its rest it is told.
      await notice.sweep(new Date(Date.now() + 2 * 60_000));
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await marksOf(ada)).toHaveLength(1);
      void bad;
      void good;
    });
  });

  // -------------------------------------------------------------------------
  describe('capability 2: with "Money in" off in Z3, no notification is sent', () => {
    it('writes no notification and no push, keeps the history row, and does not bring it back when the switch comes on', async () => {
      const ada = await addUser({ moneyIn: false });
      const phone = `ExponentPushToken[w10-${RUN}-${(seq += 1)}]`;
      await tokens.register(ada.wawuUserId, {
        expoPushToken: phone,
        platform: 'ios',
      });
      await new Promise((r) => setTimeout(r, 10));
      await arrive(funded(ada, { reference: ref('Z1'), amount: '300.00' }));

      const [row] = await rowsOf(ada);
      expect(row).toMatchObject({ direction: 'in', status: 'completed' });
      expect((await notice.sweep()).muted).toBeGreaterThanOrEqual(1);
      expect(await notesOf(ada)).toHaveLength(0);
      const marks = await marksOf(ada);
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({
        entryId: row.id,
        outcome: 'muted',
        notificationId: null,
      });
      await sender.runOnce();
      expect(stand.sentMessages().filter((m) => m.to === phone)).toHaveLength(
        0,
      );

      // Switched on later: the old credit is not queued and does not arrive.
      await prisma.notificationSettings.update({
        where: { userWawuId: ada.wawuUserId },
        data: { moneyIn: true },
      });
      await notice.sweep();
      await processOf().sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      await sender.runOnce();
      expect(stand.sentMessages().filter((m) => m.to === phone)).toHaveLength(
        0,
      );
      // A new credit is told.
      await arrive(funded(ada, { reference: ref('Z2'), amount: '10.00' }));
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await rowsOf(ada)).toHaveLength(2);
    });

    it('is on when the person never set it, and when it is set on', async () => {
      const never = await addUser();
      const on = await addUser({ moneyIn: true });
      const unset = await addUser({ moneyIn: null });
      for (const person of [never, on, unset]) await credit(person);
      await notice.sweep();
      for (const person of [never, on, unset]) {
        expect(await notesOf(person)).toHaveLength(1);
      }
    });

    it('other switches do not mute it: only "Money in" does', async () => {
      const ada = await addUser();
      await prisma.notificationSettings.create({
        data: {
          userWawuId: ada.wawuUserId,
          refunds: false,
          newFollowers: false,
          dmReminders: false,
          promotions: false,
          contentReviews: false,
          communityMessages: false,
        },
      });
      await credit(ada);
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('a switch turned off between the two readings is muted, not failed', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      jest
        .spyOn(notifications, 'isSwitchOff')
        .mockResolvedValueOnce(false) // before the write
        .mockResolvedValueOnce(true); // after emit saw it off
      jest.spyOn(notifications, 'emit').mockResolvedValueOnce(null);
      expect(await notice.noticeEntry(entry)).toBe('muted');
      expect(await notesOf(ada)).toHaveLength(0);
      expect((await marksOf(ada))[0]).toMatchObject({ outcome: 'muted' });
    });
  });

  // -------------------------------------------------------------------------
  describe('whose rows, and which rows', () => {
    it("a server tells its own provider's credits only, and a row from before the column is Fintava's", async () => {
      const ada = await addUser();
      const bayo = await addUser();
      const chi = await addUser();
      const nuvionRow = await credit(ada, { provider: 'nuvion' });
      const fintavaRow = await credit(bayo, { provider: 'fintava' });
      const oldRow = await credit(chi, { provider: null });

      // A server running Nuvion leaves Fintava's rows (and the old ones) alone.
      const nuvionServer = processOf('nuvion');
      expect(await nuvionServer.noticeEntry(fintavaRow)).toBe('skipped');
      expect(await nuvionServer.noticeEntry(oldRow)).toBe('skipped');
      // A server running Fintava leaves Nuvion's.
      const fintavaServer = processOf('fintava');
      expect(await fintavaServer.noticeEntry(nuvionRow)).toBe('skipped');
      for (const person of [ada, bayo, chi]) {
        expect(await notesOf(person)).toHaveLength(0);
        expect(await marksOf(person)).toHaveLength(0);
      }

      await fintavaServer.sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await notesOf(bayo)).toHaveLength(1);
      expect(await notesOf(chi)).toHaveLength(1);
      await nuvionServer.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
      expect(await notesOf(bayo)).toHaveLength(1);
      expect(await notesOf(chi)).toHaveLength(1);
    });

    it("a Nuvion inflow as NUV-04's handler writes it is told by a server running Nuvion", async () => {
      const ada = await addUser({ provider: 'nuvion' });
      const nuvionLedger = new LedgerService(prisma, {
        name: 'nuvion',
      } as unknown as WalletProvider);
      const recorder = new NuvionInflowRecorder(
        prisma,
        {} as never,
        nuvionLedger,
        { operationalAccountId: 'OPERATIONAL' },
      );
      const read = readNuvionTransfer({
        id: `TRF${RUN}${(seq += 1)}`.toUpperCase(),
        entity_id: 'ENT0000000000000000000001',
        account_id: 'ACC0000000000000000000001',
        amount: 750_000,
        applicable_fee: 0,
        currency: 'NGN',
        status: 'successful',
        type: 'inflow',
        payment_type: 'bank-transfer',
        unique_reference: `UR-${RUN}-${seq}`,
        counterparty_id: 'CP0000000000000000000001',
        narration: 'rent',
        created: Date.now(),
      });
      if (!read.ok) throw new Error(read.why);
      const first = await recorder.recordInflow(
        read.transfer,
        { wawuUserId: ada.wawuUserId, accountNumber: ada.accountNumber },
        'webhook',
        'delivery-1',
      );
      // The same transfer seen again (a replay, NUV-08's sweep) is the same row.
      const again = await recorder.recordInflow(
        read.transfer,
        { wawuUserId: ada.wawuUserId, accountNumber: ada.accountNumber },
        'history',
        null,
      );
      expect(again.entryId).toBe(first.entryId);
      const [row] = await rowsOf(ada);
      expect(row).toMatchObject({
        provider: 'nuvion',
        direction: 'in',
        category: 'top_up',
        status: 'completed',
        counterpartyName: null,
      });

      expect(await processOf('fintava').noticeEntry(row.id)).toBe('skipped');
      expect(await processOf('nuvion').noticeEntry(row.id)).toBe('sent');
      expect(await processOf('nuvion').noticeEntry(row.id)).toBe('skipped');
      const notes = await notesOf(ada);
      expect(notes).toHaveLength(1);
      // Nuvion's inflow names no sender: the amount alone, never a bare number.
      expect(notes[0].body).toBe('You received ₦7,500 by bank transfer.');
    });

    it.each([
      ['pending', { status: 'pending' as const }],
      ['failed', { status: 'failed' as const }],
      ['reversed', { status: 'reversed' as const }],
      ['money out', { direction: 'out' as const }],
      ['a transfer between people', { category: 'transfer' as const }],
      ['an earning', { category: 'earning' as const }],
    ])('does not tell %s', async (_name, o) => {
      const ada = await addUser();
      const entry = await credit(ada, o);
      await notice.sweep();
      expect(await notice.noticeEntry(entry)).toBe('skipped');
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(0);
    });

    it("does not tell WAWU's own merchant wallet", async () => {
      const entry = await prisma.fintavaLedgerEntry.create({
        data: {
          walletKind: 'merchant',
          wawuUserId: null,
          accountNumber: `M${RUN}${(seq += 1)}`,
          direction: 'in',
          status: 'completed',
          category: 'top_up',
          amountKobo: 5_000n,
          totalKobo: 5_000n,
          source: 'webhook',
          occurredAt: new Date(),
          provider: 'fintava',
        },
      });
      try {
        await notice.sweep();
        expect(await notice.noticeEntry(entry.id)).toBe('skipped');
        expect(
          await prisma.moneyInNotice.count({ where: { entryId: entry.id } }),
        ).toBe(0);
      } finally {
        await prisma.fintavaLedgerEntry.delete({ where: { id: entry.id } });
      }
    });

    it('does not tell a credit with a disagreement recorded on it, until it is cleared', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      await prisma.fintavaLedgerEntry.update({
        where: { id: entry },
        data: { discrepancy: 'webhook sighting: amountKobo 10000 vs 20000' },
      });
      await notice.sweep();
      expect(await notice.noticeEntry(entry)).toBe('skipped');
      expect(await notesOf(ada)).toHaveLength(0);
      await prisma.fintavaLedgerEntry.update({
        where: { id: entry },
        data: { discrepancy: null },
      });
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('a pass reads only the credits the Hub learned of inside the window; a named row is told whatever its age', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      await prisma.$executeRaw`
        UPDATE "FintavaLedgerEntry" SET "createdAt" = now() - interval '100 hours'
         WHERE "id" = ${entry}`;
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(0);
      // A longer window reads it (the setting, in hours).
      const wide = new MoneyInNoticeService(prisma, provider, notifications, {
        get: (k: string) =>
          k === 'MONEY_IN_NOTICE_WINDOW_HOURS' ? '200' : undefined,
      } as unknown as ConfigService);
      await wide.sweep();
      expect(await notesOf(ada)).toHaveLength(1);
    });

    it('a bad window setting stops the server at boot', () => {
      expect(
        () =>
          new MoneyInNoticeService(prisma, provider, notifications, {
            get: () => 'soon',
          } as unknown as ConfigService),
      ).toThrow(/MONEY_IN_NOTICE_WINDOW_HOURS/);
    });
  });

  // -------------------------------------------------------------------------
  describe('the mark and the migration', () => {
    it('a deleted ledger row takes its mark with it (an account deleted)', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      await notice.sweep();
      expect(await marksOf(ada)).toHaveLength(1);
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { wawuUserId: ada.wawuUserId },
      });
      expect(
        await prisma.moneyInNotice.count({ where: { entryId: entry } }),
      ).toBe(0);
    });

    it('keeps its mark when the notification is deleted by the person', async () => {
      const ada = await addUser();
      await credit(ada);
      await notice.sweep();
      await prisma.notification.deleteMany({
        where: { userWawuId: ada.wawuUserId },
      });
      await notice.sweep();
      await processOf().sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      expect(await marksOf(ada)).toHaveLength(1);
    });

    it('the key itself refuses a second mark for one row', async () => {
      const ada = await addUser();
      const entry = await credit(ada);
      await notice.noticeEntry(entry);
      await expect(
        prisma.moneyInNotice.create({
          data: { entryId: entry, outcome: 'sent', notificationId: null },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('the migration marks the credits already there as not news, and leaves a pending one to be told when it completes', async () => {
      const ada = await addUser();
      const done = await credit(ada, { kobo: 1_000 });
      const failed = await credit(ada, { kobo: 2_000, status: 'failed' });
      const waiting = await credit(ada, { kobo: 3_000, status: 'pending' });
      const sent = await credit(ada, { kobo: 4_000 });
      const outRow = await credit(ada, { kobo: 5_000, direction: 'out' });
      await prisma.moneyInNotice.create({
        data: { entryId: sent, outcome: 'sent', notificationId: 'n-1' },
      });

      await prisma.$executeRawUnsafe(backfillSql());
      await prisma.$executeRawUnsafe(backfillSql()); // safe to replay

      const marks = await prisma.moneyInNotice.findMany({
        where: { entryId: { in: [done, failed, waiting, sent, outRow] } },
      });
      const by = new Map(marks.map((m) => [m.entryId, m]));
      expect(by.get(done)?.outcome).toBe('before');
      expect(by.get(failed)?.outcome).toBe('before');
      expect(by.get(sent)).toMatchObject({
        outcome: 'sent',
        notificationId: 'n-1',
      });
      expect(by.has(waiting)).toBe(false);
      expect(by.has(outRow)).toBe(false);

      // A row marked "before" is never told; the pending one is, once it completes.
      await notice.sweep();
      expect(await notesOf(ada)).toHaveLength(0);
      await prisma.fintavaLedgerEntry.update({
        where: { id: waiting },
        data: { status: 'completed', completedAt: new Date() },
      });
      await notice.sweep();
      const notes = await notesOf(ada);
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain('₦30');
    });
  });
});
