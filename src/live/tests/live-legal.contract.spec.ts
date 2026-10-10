// Contract tests for the legal conversation's live signal (task LEGAL-02).
//
// A consultant who writes on a legal matter wakes the client's phone: one
// `legal.thread` frame, to the owner's sockets only, carrying the matter's id
// and no words. The phone reads the conversation from `GET /legal/assistant/{id}`,
// which is where the ownership check is.
//
// Every identity is a throwaway registered by this spec and every row it
// writes is removed in afterAll (README, test hygiene).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import type { AddressInfo } from 'net';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import {
  GEMINI_CLIENT,
  type GeminiClient,
} from '../../common/ai/gemini-client.interface';
import { LegalIntakeModule } from '../../legal-intake/legal-intake.module';
import { LegalChatService } from '../../legal-intake/legal-chat.service';
import { LiveModule } from '../live.module';
import { LivePublisher } from '../live-publisher.service';
import { decodeLiveCursor } from '../live-cursor';
import {
  Client,
  MOCK_DIR,
  MOCK_WAWU_ID_BASE,
  MOCK_WAWU_ID_PORT,
  registerPerson,
  settle,
  waitForHealth,
  type Person,
} from './live-test-kit.test';

/** The provider is never called: nothing here asks the assistant anything. */
const noProvider: GeminiClient = {
  chat: () => Promise.reject(new Error('no provider in this spec')),
  generateBrief: () => Promise.reject(new Error('no provider in this spec')),
};

describe('Legal conversation live signal (contract, LEGAL-02)', () => {
  let app: INestApplication;
  let port: number;
  let prisma: PrismaService;
  let chat: LegalChatService;
  let publisher: LivePublisher;
  let mockWawuId: ChildProcess | undefined;
  let ada: Person;
  let bola: Person;
  let adaRequest: string;
  let bolaRequest: string;
  const opened: Client[] = [];
  const open = async (who: Person) => {
    const c = await Client.open(port, who.token);
    opened.push(c);
    return c;
  };
  const legalFrames = (c: Client) =>
    c.frames.filter((f) => f.type === 'legal.thread');

  async function matterFor(who: Person): Promise<string> {
    const row = await prisma.legalRequest.create({
      data: {
        wawuUserId: who.sub,
        serviceCode: 'live-spec',
        serviceName: 'Live spec',
        category: 'live-spec',
        path: 'consultation',
        status: 'awaiting_quote',
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: MOCK_DIR,
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ada = await registerPerson('LegalAda');
    bola = await registerPerson('LegalBola');
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        LiveModule,
        LegalIntakeModule,
      ],
    })
      .overrideProvider(GEMINI_CLIENT)
      .useValue(noProvider)
      .compile();
    app = moduleRef.createNestApplication();
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
    await app.listen(0);
    port = (
      (app.getHttpServer() as { address(): unknown }).address() as AddressInfo
    ).port;
    prisma = app.get(PrismaService);
    chat = app.get(LegalChatService);
    publisher = app.get(LivePublisher);
    adaRequest = await matterFor(ada);
    bolaRequest = await matterFor(bola);
  }, 40000);

  afterAll(async () => {
    for (const c of opened) c.close();
    if (prisma) {
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: { in: [adaRequest, bolaRequest] } },
      });
      await prisma.legalRequest.deleteMany({
        where: { id: { in: [adaRequest, bolaRequest] } },
      });
    }
    await app?.close();
    if (mockWawuId) mockWawuId.kill();
  });

  it("a consultant's message reaches the client's open socket as one legal.thread frame, within two seconds, with no words in it", async () => {
    const adaSocket = await open(ada);
    const started = Date.now();
    await chat.sendAsConsultant(
      adaRequest,
      'admin-live-spec',
      'Hello Ada, I read your brief.',
    );
    const frame = await adaSocket.event(
      (e) => (e.type as string) === 'legal.thread',
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(frame).toMatchObject({
      type: 'legal.thread',
      legalRequestId: adaRequest,
    });
    expect(Object.keys(frame).sort()).toEqual([
      'cursor',
      'legalRequestId',
      'type',
    ]);
    expect(JSON.stringify(frame)).not.toContain('Hello Ada');
    await settle();
    expect(legalFrames(adaSocket)).toHaveLength(1);
  });

  it("its cursor is the message's own time, as every event's is, so a chat message is never skipped on catch-up", async () => {
    const adaSocket = await open(ada);
    await chat.sendAsConsultant(adaRequest, 'admin-live-spec', 'Second.');
    const frame = await adaSocket.event(
      (e) => (e.type as string) === 'legal.thread',
    );
    const row = await prisma.legalChatMessage.findFirst({
      where: { legalRequestId: adaRequest, body: 'Second.' },
    });
    expect(decodeLiveCursor(frame.cursor).at.getTime()).toBe(
      row!.createdAt.getTime(),
    );
  });

  it("another person's socket is sent nothing", async () => {
    const adaSocket = await open(ada);
    const bolaSocket = await open(bola);
    await chat.sendAsConsultant(adaRequest, 'admin-live-spec', 'Only for Ada.');
    await adaSocket.event((e) => (e.type as string) === 'legal.thread');
    await settle();
    expect(legalFrames(bolaSocket)).toHaveLength(0);
    // And Bola's own matter wakes Bola, not Ada.
    await chat.sendAsConsultant(
      bolaRequest,
      'admin-live-spec',
      'Only for Bola.',
    );
    await bolaSocket.event((e) => (e.type as string) === 'legal.thread');
    expect(legalFrames(bolaSocket).map((f) => f.legalRequestId)).toEqual([
      bolaRequest,
    ]);
    await settle();
    expect(legalFrames(adaSocket).map((f) => f.legalRequestId)).toEqual([
      adaRequest,
    ]);
  });

  it("a signal for a client's own message, or for a message on another matter, wakes nobody", async () => {
    const adaSocket = await open(ada);
    const mine = await prisma.legalChatMessage.create({
      data: {
        legalRequestId: adaRequest,
        authorRole: 'client',
        body: 'From the client.',
      },
    });
    await publisher.publish({
      kind: 'legal.thread',
      legalRequestId: adaRequest,
      messageId: mine.id,
    });
    const theirs = await prisma.legalChatMessage.create({
      data: {
        legalRequestId: bolaRequest,
        authorRole: 'consultant',
        authorAdminId: 'admin-live-spec',
        body: 'On Bola.',
      },
    });
    await publisher.publish({
      kind: 'legal.thread',
      legalRequestId: adaRequest,
      messageId: theirs.id,
    });
    await publisher.publish({
      kind: 'legal.thread',
      legalRequestId: adaRequest,
      messageId: '00000000-0000-4000-8000-000000000000',
    });
    await settle(800);
    expect(legalFrames(adaSocket)).toHaveLength(0);
  });

  it('a matter nobody is connected for is not an error, and the message is still stored and readable', async () => {
    const gone = await matterFor(await registerPerson('LegalGone'));
    try {
      const view = await chat.sendAsConsultant(
        gone,
        'admin-live-spec',
        'Nobody is listening.',
      );
      expect(view.messages.some((m) => m.body === 'Nobody is listening.')).toBe(
        true,
      );
    } finally {
      await prisma.legalChatMessage.deleteMany({
        where: { legalRequestId: gone },
      });
      await prisma.legalRequest.delete({ where: { id: gone } });
    }
  });
});
