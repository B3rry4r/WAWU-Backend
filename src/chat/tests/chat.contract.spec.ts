// Contract tests for free chat between two users (task INBOX-06, R-13).
//
// The two capability checks the task names, end to end over HTTP with real
// tokens from the local mock WAWU ID:
//   1. Two users can chat; a blocked user cannot message.
//   2. A user sees read state on their sent message.
// plus who may see a chat, attachments, paging and retries.
//
// Every identity here is a throwaway registered by this spec, and every row
// it writes is removed in afterAll (README, test hygiene).

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

// Storage is configured with a name nothing resolves (FIX-104): the Hub signs
// links on this machine, so a link's life can be read, and the rows the spec
// writes by hand are `confirmed`, so nothing here asks a bucket.
process.env.STORAGE_ENDPOINT = 'https://storage.chat-spec.invalid';
process.env.STORAGE_ACCESS_KEY_ID = 'chat-spec-key';
process.env.STORAGE_SECRET_ACCESS_KEY = 'chat-spec-secret';
process.env.STORAGE_BUCKET = 'chat-spec-bucket';
process.env.STORAGE_REGION = 'auto';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ChatModule } from '../chat.module';
import { StorageService } from '../../storage/storage.service';
import type {
  ChatAttachmentLink,
  ChatAttachmentRules,
} from '../chat-view.type';
import { CHAT_LIMITS } from '../chat-limits';
import { MAX_UPLOAD_BYTES } from '../../storage/dto/presign-upload.dto';
import type {
  ChatMessage,
  ChatMessagePage,
  ChatReadMark,
  ChatSummary,
  ChatSummaryPage,
} from '../chat-view.type';

/** The `data` of a success envelope, typed as the route's contract says. */
const chat = (res: Response) => (res.body as { data: ChatSummary }).data;
const chats = (res: Response) => (res.body as { data: ChatSummaryPage }).data;
const message = (res: Response) => (res.body as { data: ChatMessage }).data;
const messages = (res: Response) =>
  (res.body as { data: ChatMessagePage }).data;
const readMark = (res: Response) => (res.body as { data: ChatReadMark }).data;
const refusal = (res: Response) =>
  res.body as { message: string; reason?: unknown };

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let nonceSeq = 0;
async function registerPerson(
  label: string,
): Promise<{ sub: string; token: string; fullName: string }> {
  const nonce = `${Date.now().toString().slice(-8)}${(nonceSeq += 1)}`;
  const fullName = `Chat Spec ${label}`;
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName,
      email: `chat-spec-${label.toLowerCase()}-${nonce}@test.wawu.dev`,
      phone: `+2347${nonce}`,
      country: 'NG',
      password: 'not-a-real-password',
    }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id register failed: ${res.status}`);
  const body = (await res.json()) as {
    accessToken: string;
    user: { id: string };
  };
  return { sub: body.user.id, token: body.accessToken, fullName };
}

describe('Free chat (contract, INBOX-06)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;

  // Ada and Bola chat. Chidi is in nobody's chat. Dayo has no Hub profile at
  // all (WAWU ID knows them), like most people who never edited a profile.
  let ada: { sub: string; token: string; fullName: string };
  let bola: { sub: string; token: string; fullName: string };
  let chidi: { sub: string; token: string; fullName: string };
  let dayo: { sub: string; token: string; fullName: string };
  let chatId: string;

  const http = () => request(app.getHttpServer());
  const as = (who: { token: string }) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${who.token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${who.token}`).send(body),
    del: (url: string) =>
      http().delete(url).set('Authorization', `Bearer ${who.token}`),
  });
  const everyone = () => [ada.sub, bola.sub, chidi.sub, dayo.sub];

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    ada = await registerPerson('Ada');
    bola = await registerPerson('Bola');
    chidi = await registerPerson('Chidi');
    dayo = await registerPerson('Dayo');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        BlockedAccountModule,
        ChatModule,
      ],
    }).compile();
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
    prisma = moduleRef.get(PrismaService);

    for (const p of [ada, bola, chidi]) {
      await prisma.userProfile.create({
        data: {
          wawuUserId: p.sub,
          accountType: 'user',
          handle: `chatspec_${p.sub.slice(0, 8)}`,
          bio: 'Fixture for chat.contract.spec.ts.',
          interests: [],
        },
      });
    }
  }, 40000);

  afterAll(async () => {
    if (prisma) {
      const ids = everyone();
      await prisma.chatConversation.deleteMany({
        where: {
          OR: [{ userAWawuId: { in: ids } }, { userBWawuId: { in: ids } }],
        },
      });
      await prisma.storageObject.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
      await prisma.blockedAccount.deleteMany({
        where: {
          OR: [{ userWawuId: { in: ids } }, { blockedWawuId: { in: ids } }],
        },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: ids } },
      });
    }
    if (app) await app.close();
    mockWawuId?.kill();
  });

  describe('opening a chat', () => {
    it('401s with no token', async () => {
      await http().post('/chats').send({ wawuId: randomUUID() }).expect(401);
      await http().get('/chats').expect(401);
    });

    it('opens a chat with another person, showing who they are', async () => {
      const res = await as(ada)
        .post('/chats', { wawuId: bola.sub })
        .expect(200);
      const opened = chat(res);
      chatId = opened.id;
      expect(opened.other).toEqual({
        wawuId: bola.sub,
        name: bola.fullName,
        handle: `chatspec_${bola.sub.slice(0, 8)}`,
        avatarUrl: null,
        verification: expect.any(Object) as unknown,
      });
      expect(opened).toMatchObject({
        lastMessage: null,
        unreadCount: 0,
        myLastReadAt: null,
        otherLastReadAt: null,
        canMessage: true,
      });
    });

    it('finds the same chat from either side', async () => {
      const again = await as(ada)
        .post('/chats', { wawuId: bola.sub })
        .expect(200);
      const fromBola = await as(bola)
        .post('/chats', { wawuId: ada.sub })
        .expect(200);
      expect(chat(again).id).toBe(chatId);
      expect(chat(fromBola).id).toBe(chatId);
      expect(chat(fromBola).other.wawuId).toBe(ada.sub);
      expect(
        await prisma.chatConversation.count({ where: { id: chatId } }),
      ).toBe(1);
    });

    it('opens a chat with someone who has no Hub profile but is a WAWU ID user', async () => {
      const res = await as(ada)
        .post('/chats', { wawuId: dayo.sub })
        .expect(200);
      expect(chat(res).other).toMatchObject({
        wawuId: dayo.sub,
        name: dayo.fullName,
        handle: null,
      });
    });

    it('refuses yourself (400), a stranger to WAWU (404) and a malformed id (400)', async () => {
      await as(ada).post('/chats', { wawuId: ada.sub }).expect(400);
      await as(ada).post('/chats', { wawuId: randomUUID() }).expect(404);
      await as(ada).post('/chats', { wawuId: '08031234567' }).expect(400);
      await as(ada).post('/chats', {}).expect(400);
    });
  });

  describe('two users can chat', () => {
    it('Ada sends a text; Bola reads it as unread from Ada', async () => {
      const sent = await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'Hello Bola' })
        .expect(201);
      expect(message(sent)).toMatchObject({
        chatId,
        senderWawuId: ada.sub,
        mine: true,
        kind: 'text',
        text: 'Hello Bola',
        attachment: null,
        readState: 'sent',
      });

      const page = await as(bola).get(`/chats/${chatId}/messages`).expect(200);
      expect(messages(page).items).toHaveLength(1);
      expect(messages(page).items[0]).toMatchObject({
        text: 'Hello Bola',
        mine: false,
        readState: null,
      });
      const summary = await as(bola).get(`/chats/${chatId}`).expect(200);
      expect(chat(summary).unreadCount).toBe(1);
      expect(chat(summary).lastMessage?.text).toBe('Hello Bola');
    });

    it('Bola replies and Ada receives it', async () => {
      await as(bola)
        .post(`/chats/${chatId}/messages`, { text: 'Hi Ada' })
        .expect(201);
      const page = await as(ada).get(`/chats/${chatId}/messages`).expect(200);
      expect(messages(page).items.map((m) => m.text)).toEqual([
        'Hi Ada',
        'Hello Bola',
      ]);
      expect(chat(await as(ada).get(`/chats/${chatId}`)).unreadCount).toBe(1);
    });

    it('lists the chat for both people, newest activity first', async () => {
      const forAda = await as(ada).get('/chats').expect(200);
      expect(chats(forAda).items[0].id).toBe(chatId);
      expect(chats(forAda).items[0].lastMessage?.text).toBe('Hi Ada');
      const forBola = await as(bola).get('/chats').expect(200);
      expect(chats(forBola).items.map((c) => c.id)).toContain(chatId);
      expect(chats(forBola).nextCursor).toBeNull();
    });

    it('refuses an empty message and a blank one', async () => {
      await as(ada).post(`/chats/${chatId}/messages`, {}).expect(400);
      await as(ada)
        .post(`/chats/${chatId}/messages`, { text: '   ' })
        .expect(400);
      await as(ada)
        .post(`/chats/${chatId}/messages`, {
          text: 'x'.repeat(CHAT_LIMITS.textMaxLength + 1),
        })
        .expect(400);
    });

    it('a resend with the same clientMessageId returns the first message, stored once', async () => {
      const body = { text: 'Sent twice?', clientMessageId: 'retry-0001-abcd' };
      const first = await as(ada)
        .post(`/chats/${chatId}/messages`, body)
        .expect(201);
      const second = await as(ada)
        .post(`/chats/${chatId}/messages`, body)
        .expect(201);
      expect(message(second).id).toBe(message(first).id);
      expect(message(first).clientMessageId).toBe('retry-0001-abcd');
      expect(
        await prisma.chatMessage.count({
          where: { conversationId: chatId, clientMessageId: 'retry-0001-abcd' },
        }),
      ).toBe(1);
      // The other person never sees the sender's own id.
      const forBola = await as(bola)
        .get(`/chats/${chatId}/messages?limit=1`)
        .expect(200);
      expect(messages(forBola).items[0].clientMessageId).toBeNull();
    });

    it('sending is reading: your own message clears what came before it', async () => {
      expect(chat(await as(ada).get(`/chats/${chatId}`)).unreadCount).toBe(0);
    });
  });

  describe('a user sees read state on their sent message', () => {
    it('stays "sent" until the other person reads, then turns "read"', async () => {
      const sent = await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'Did you see this?' })
        .expect(201);
      expect(message(sent).readState).toBe('sent');

      const before = await as(ada)
        .get(`/chats/${chatId}/messages?limit=1`)
        .expect(200);
      expect(messages(before).items[0].readState).toBe('sent');
      expect(
        chat(await as(bola).get(`/chats/${chatId}`)).unreadCount,
      ).toBeGreaterThan(0);

      const mark = await as(bola).post(`/chats/${chatId}/read`).expect(200);
      expect(readMark(mark)).toMatchObject({
        chatId,
        lastReadMessageId: message(sent).id,
        lastReadAt: message(sent).createdAt,
        unreadCount: 0,
      });

      const after = await as(ada).get(`/chats/${chatId}/messages`).expect(200);
      const mine = messages(after).items.filter((m) => m.mine);
      expect(mine.length).toBeGreaterThan(0);
      for (const m of mine) expect(m.readState).toBe('read');
      const summary = await as(ada).get(`/chats/${chatId}`).expect(200);
      expect(chat(summary).otherLastReadAt).toBe(message(sent).createdAt);
    });

    it('a read mark never moves back, and an unknown message is 404', async () => {
      const page = await as(bola).get(`/chats/${chatId}/messages`).expect(200);
      const oldest = messages(page).items[messages(page).items.length - 1];
      const mark = await as(bola)
        .post(`/chats/${chatId}/read`, { messageId: oldest.id })
        .expect(200);
      expect(readMark(mark).lastReadMessageId).toBe(messages(page).items[0].id);
      await as(bola)
        .post(`/chats/${chatId}/read`, { messageId: randomUUID() })
        .expect(404);
    });

    it('a new message is "sent" again until it too is read', async () => {
      const sent = await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'One more' })
        .expect(201);
      const page = await as(ada)
        .get(`/chats/${chatId}/messages?limit=2`)
        .expect(200);
      expect(messages(page).items[0]).toMatchObject({
        id: message(sent).id,
        readState: 'sent',
      });
      expect(messages(page).items[1].readState).toBe('read');
    });
  });

  describe('only the two people in a chat can reach it', () => {
    it('answers 404 to anyone else, as if it did not exist', async () => {
      await as(chidi).get(`/chats/${chatId}`).expect(404);
      await as(chidi).get(`/chats/${chatId}/messages`).expect(404);
      await as(chidi)
        .post(`/chats/${chatId}/messages`, { text: 'Hi' })
        .expect(404);
      await as(chidi).post(`/chats/${chatId}/read`).expect(404);
      await as(chidi)
        .post(`/chats/${chatId}/attachments`, {
          contentType: 'image/jpeg',
          contentLength: 10,
        })
        .expect(404);
      const list = await as(chidi).get('/chats').expect(200);
      expect(chats(list).items).toEqual([]);
      await as(ada).get(`/chats/${randomUUID()}`).expect(404);
      await as(ada).get('/chats/not-a-uuid').expect(400);
    });
  });

  describe('photos, videos and files', () => {
    const storeUpload = (
      owner: string,
      folder: string,
      contentType: string,
      ext: string,
    ) =>
      prisma.storageObject.create({
        data: {
          wawuUserId: owner,
          key: `${folder}/${owner}/${randomUUID()}.${ext}`,
          bytes: 2048,
          contentType,
          folder,
          // A file that has landed: a send asks for one (FIX-104).
          status: 'confirmed',
        },
      });

    it('sends a photo and a named PDF the sender uploaded for a chat', async () => {
      const photo = await storeUpload(
        ada.sub,
        'chat/media',
        'image/jpeg',
        'jpg',
      );
      const res = await as(ada)
        .post(`/chats/${chatId}/messages`, { attachment: { key: photo.key } })
        .expect(201);
      expect(message(res)).toMatchObject({
        kind: 'image',
        text: null,
        attachment: { contentType: 'image/jpeg', bytes: 2048, name: null },
      });
      expect(message(res).attachment).toHaveProperty('url');

      const pdf = await storeUpload(
        ada.sub,
        'chat/file',
        'application/pdf',
        'pdf',
      );
      const withCaption = await as(ada)
        .post(`/chats/${chatId}/messages`, {
          text: 'The contract',
          attachment: { key: pdf.key, name: 'contract.pdf' },
        })
        .expect(201);
      expect(message(withCaption)).toMatchObject({
        kind: 'file',
        text: 'The contract',
        attachment: { contentType: 'application/pdf', name: 'contract.pdf' },
      });
      const forBola = await as(bola)
        .get(`/chats/${chatId}/messages?limit=1`)
        .expect(200);
      expect(messages(forBola).items[0].attachment?.name).toBe('contract.pdf');
    });

    it('refuses a key someone else uploaded, one outside the chat folders, or one never uploaded', async () => {
      const bolas = await storeUpload(
        bola.sub,
        'chat/media',
        'image/jpeg',
        'jpg',
      );
      await as(ada)
        .post(`/chats/${chatId}/messages`, { attachment: { key: bolas.key } })
        .expect(400);
      const avatar = await storeUpload(ada.sub, 'avatars', 'image/jpeg', 'jpg');
      await as(ada)
        .post(`/chats/${chatId}/messages`, { attachment: { key: avatar.key } })
        .expect(400);
      await as(ada)
        .post(`/chats/${chatId}/messages`, {
          attachment: { key: `chat/media/${ada.sub}/${randomUUID()}.jpg` },
        })
        .expect(400);
    });

    it('upload links: a PDF over the limit is 413, a type a chat cannot hold is 400', async () => {
      await as(ada)
        .post(`/chats/${chatId}/attachments`, {
          contentType: 'application/pdf',
          contentLength: CHAT_LIMITS.fileMaxBytes + 1,
        })
        .expect(413);
      await as(ada)
        .post(`/chats/${chatId}/attachments`, {
          contentType: 'text/html',
          contentLength: 10,
        })
        .expect(400);
      // Storage signs the link when it is configured, and says it is not
      // (503) when it is not; either way the chat checks have passed.
      const ok = await as(ada).post(`/chats/${chatId}/attachments`, {
        contentType: 'application/pdf',
        contentLength: CHAT_LIMITS.fileMaxBytes,
      });
      expect([200, 503]).toContain(ok.status);
    });

    // FIX-104 moved this from the 512 MB every upload has to the 100 MB the
    // Hub already puts on a picture or a video in a message (CHAT_LIMITS).
    it('upload links: a photo or video over 100 MB is 413, over every upload limit is 400', async () => {
      for (const contentLength of [MAX_UPLOAD_BYTES + 1, 600 * 1024 * 1024]) {
        await as(ada)
          .post(`/chats/${chatId}/attachments`, {
            contentType: 'video/mp4',
            contentLength,
          })
          .expect(400);
      }
      for (const contentType of ['video/mp4', 'image/jpeg']) {
        const over = await as(ada)
          .post(`/chats/${chatId}/attachments`, {
            contentType,
            contentLength: CHAT_LIMITS.mediaMaxBytes + 1,
          })
          .expect(413);
        expect(refusal(over).message).toBe(
          'A photo or video in a chat can be up to 100 MB.',
        );
      }
      const atLimit = await as(ada).post(`/chats/${chatId}/attachments`, {
        contentType: 'video/mp4',
        contentLength: CHAT_LIMITS.mediaMaxBytes,
      });
      expect(atLimit.status).toBe(200);
    });

    it("a type a chat cannot hold is refused in the Hub's own words", async () => {
      const res = await as(ada)
        .post(`/chats/${chatId}/attachments`, {
          contentType: 'application/zip',
          contentLength: 10,
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'A chat can hold a photo (PNG, JPEG or WebP), a video (MP4 or MOV) or a PDF.',
      );
    });

    it("GET /chats/attachment-rules says what a chat takes, from the Hub's limits", async () => {
      const res = await as(bola).get('/chats/attachment-rules').expect(200);
      const rules = (res.body as { data: ChatAttachmentRules }).data;
      expect(rules.file).toEqual({
        contentTypes: ['application/pdf'],
        maxBytes: CHAT_LIMITS.fileMaxBytes,
      });
      expect(rules.media.maxBytes).toBe(CHAT_LIMITS.mediaMaxBytes);
      expect(rules.media.contentTypes).toEqual(
        expect.arrayContaining(['image/jpeg', 'video/mp4']),
      );
      await http().get('/chats/attachment-rules').expect(401);
    });

    it('a file that never landed in storage is not sent', async () => {
      const photo = await storeUpload(
        ada.sub,
        'chat/media',
        'image/jpeg',
        'jpg',
      );
      const storage = moduleRef.get(StorageService);
      const asked = jest.spyOn(storage, 'confirmUpload');
      asked.mockResolvedValueOnce(false);
      const res = await as(ada)
        .post(`/chats/${chatId}/messages`, { attachment: { key: photo.key } })
        .expect(400);
      expect(refusal(res).message).toBe(
        'That file did not finish uploading. Try sending it again.',
      );
      expect(
        await prisma.chatMessage.count({
          where: { conversationId: chatId, attachmentKey: photo.key },
        }),
      ).toBe(0);
      asked.mockRestore();
      await as(ada)
        .post(`/chats/${chatId}/messages`, { attachment: { key: photo.key } })
        .expect(201);
    });

    it('a file given back between the check and the send is not sent (round 2)', async () => {
      const photo = await storeUpload(
        ada.sub,
        'chat/media',
        'image/jpeg',
        'jpg',
      );
      const storage = moduleRef.get(StorageService);
      // The release lands after the send has looked at the file and before it writes the message.
      const asked = jest
        .spyOn(storage, 'confirmUpload')
        .mockImplementationOnce(async () => {
          await prisma.storageObject.update({
            where: { key: photo.key },
            data: { status: 'abandoned', releasedAt: new Date() },
          });
          return true;
        });
      const res = await as(ada)
        .post(`/chats/${chatId}/messages`, { attachment: { key: photo.key } })
        .expect(400);
      expect(refusal(res).message).toBe(
        'That attachment was not uploaded for a chat. Upload it again.',
      );
      expect(
        await prisma.chatMessage.count({
          where: { conversationId: chatId, attachmentKey: photo.key },
        }),
      ).toBe(0);
      asked.mockRestore();
    });

    it('only the two people in the chat get a link, and it is short-lived', async () => {
      const pdf = await storeUpload(
        ada.sub,
        'chat/file',
        'application/pdf',
        'pdf',
      );
      const photo = await storeUpload(
        ada.sub,
        'chat/media',
        'image/jpeg',
        'jpg',
      );
      const sentPdf = message(
        await as(ada)
          .post(`/chats/${chatId}/messages`, {
            attachment: { key: pdf.key, name: 'invoice.pdf' },
          })
          .expect(201),
      );
      const sentPhoto = message(
        await as(ada)
          .post(`/chats/${chatId}/messages`, { attachment: { key: photo.key } })
          .expect(201),
      );
      const text = message(
        await as(ada)
          .post(`/chats/${chatId}/messages`, { text: 'No file here' })
          .expect(201),
      );
      const linkPath = (id: string) =>
        `/chats/${chatId}/messages/${id}/attachment`;
      for (const who of [ada, bola]) {
        for (const sent of [sentPdf, sentPhoto]) {
          const res = await as(who).get(linkPath(sent.id)).expect(200);
          const link = (res.body as { data: ChatAttachmentLink }).data;
          expect(link.url).toContain('X-Amz-Expires=900');
          expect(link.contentType).toBe(sent.attachment?.contentType);
          expect(link.name).toBe(sent.attachment?.name ?? null);
          const left = Date.parse(link.expiresAt) - Date.now();
          expect(left).toBeGreaterThan(0);
          expect(left).toBeLessThanOrEqual(900_000);
        }
      }
      // The links a message list carries are short-lived too, not the seven days of the long read link.
      const page = await as(bola).get(`/chats/${chatId}/messages?limit=5`);
      const withFiles = messages(page).items.filter((m) => m.attachment);
      expect(withFiles.length).toBeGreaterThan(1);
      for (const m of withFiles) {
        expect(m.attachment?.url).toContain('X-Amz-Expires=900');
      }
      // Someone outside the chat, a message with no file, and a message that is not there all answer 404.
      await as(chidi).get(linkPath(sentPdf.id)).expect(404);
      await as(chidi).get(linkPath(sentPhoto.id)).expect(404);
      await as(bola).get(linkPath(text.id)).expect(404);
      await as(bola).get(linkPath(randomUUID())).expect(404);
      await as(bola)
        .get(`/chats/${randomUUID()}/messages/${sentPdf.id}/attachment`)
        .expect(404);
      await as(bola)
        .get(`/chats/${chatId}/messages/not-a-uuid/attachment`)
        .expect(400);
      await http().get(linkPath(sentPdf.id)).expect(401);
    });

    it("what is sent in a chat counts toward the sender's storage on the chat path only, and a chat file that does not fit is refused", async () => {
      // Round 2 (lead ruling): GET /uploads/usage and the content presign sum
      // content only, as on main; the chat upload sums content plus chat.
      const storage = moduleRef.get(StorageService);
      const before = await storage.usageFor(ada.sub);
      // The chat files this spec has already stored for Ada count on the chat path.
      const chatHeld =
        (
          await prisma.storageObject.aggregate({
            _sum: { bytes: true },
            where: {
              wawuUserId: ada.sub,
              status: { in: ['pending', 'confirmed'] },
              folder: { in: ['chat/media', 'chat/file'] },
            },
          })
        )._sum.bytes ?? 0;
      const filler = await prisma.storageObject.create({
        data: {
          wawuUserId: ada.sub,
          key: `chat/media/${ada.sub}/${randomUUID()}.mp4`,
          bytes: before.limitBytes - before.usedBytes - chatHeld - 1000,
          contentType: 'video/mp4',
          folder: 'chat/media',
          status: 'confirmed',
        },
      });
      try {
        // The chat file is not in what the web reads.
        expect(await storage.usageFor(ada.sub)).toEqual(before);
        const refused = await as(ada)
          .post(`/chats/${chatId}/attachments`, {
            contentType: 'application/pdf',
            contentLength: 2000,
          })
          .expect(413);
        expect(refusal(refused).reason).toMatchObject({
          code: 'storage_limit_reached',
          neededBytes: 2000,
          usedBytes: before.limitBytes - 1000,
          limitBytes: before.limitBytes,
        });
        // What still fits is signed, and counts toward the next chat upload.
        await as(ada)
          .post(`/chats/${chatId}/attachments`, {
            contentType: 'application/pdf',
            contentLength: 900,
          })
          .expect(200);
        await as(ada)
          .post(`/chats/${chatId}/attachments`, {
            contentType: 'application/pdf',
            contentLength: 200,
          })
          .expect(413);
        expect(await storage.usageFor(ada.sub)).toEqual(before);
      } finally {
        await prisma.storageObject.deleteMany({
          where: { wawuUserId: ada.sub, bytes: { in: [900] } },
        });
        await prisma.storageObject.delete({ where: { id: filler.id } });
      }
    });

    it('the public upload route still refuses the chat folders', async () => {
      await as(ada)
        .post('/uploads/presign', {
          folder: 'chat/media',
          contentType: 'image/jpeg',
          extension: 'jpg',
          contentLength: 10,
        })
        .expect(400);
    });
  });

  describe('paging', () => {
    it('pages messages newest first with an opaque cursor, without repeats', async () => {
      const all = await as(ada)
        .get(`/chats/${chatId}/messages?limit=100`)
        .expect(200);
      const ids: string[] = messages(all).items.map((m) => m.id);
      expect(ids.length).toBeGreaterThan(4);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/chats/${chatId}/messages?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await as(ada).get(url).expect(200);
        seen.push(...messages(page).items.map((m) => m.id));
        cursor = messages(page).nextCursor;
      } while (cursor);
      expect(seen).toEqual(ids);
    });

    it('refuses a cursor it did not give out and a limit out of range', async () => {
      await as(ada).get(`/chats/${chatId}/messages?cursor=bm9wZQ`).expect(400);
      await as(ada).get(`/chats/${chatId}/messages?limit=0`).expect(400);
      await as(ada).get(`/chats/${chatId}/messages?limit=101`).expect(400);
    });
  });

  describe('two messages in the same millisecond', () => {
    // Read marks follow the list order, (createdAt, id); a mark that compared
    // times alone would call both read, or neither unread, when only one was.
    it('reading up to the first of two same-time messages leaves the second unread and "sent"', async () => {
      const opened = await as(ada)
        .post('/chats', { wawuId: dayo.sub })
        .expect(200);
      const dayoChat = chat(opened).id;
      const at = new Date();
      const [low, high] = [randomUUID(), randomUUID()].sort();
      await prisma.chatMessage.createMany({
        data: [low, high].map((id) => ({
          id,
          conversationId: dayoChat,
          senderWawuId: ada.sub,
          kind: 'text',
          text: `same time ${id.slice(0, 4)}`,
          createdAt: at,
        })),
      });

      const before = await as(dayo).get(`/chats/${dayoChat}`).expect(200);
      expect(chat(before).unreadCount).toBe(2);

      const mark = await as(dayo)
        .post(`/chats/${dayoChat}/read`, { messageId: low })
        .expect(200);
      expect(readMark(mark)).toMatchObject({
        lastReadMessageId: low,
        unreadCount: 1,
      });

      const page = await as(ada).get(`/chats/${dayoChat}/messages`).expect(200);
      const state = new Map(
        messages(page).items.map((m) => [m.id, m.readState]),
      );
      expect(state.get(low)).toBe('read');
      expect(state.get(high)).toBe('sent');

      const all = await as(dayo).post(`/chats/${dayoChat}/read`).expect(200);
      expect(readMark(all)).toMatchObject({
        lastReadMessageId: high,
        unreadCount: 0,
      });
    });
  });

  describe('a blocked user cannot message', () => {
    let blockId: string;

    it('after Bola blocks Ada, neither can send, open the chat again or upload', async () => {
      const block = await as(bola)
        .post('/settings/privacy/blocked', { blockedWawuId: ada.sub })
        .expect(201);
      blockId = (block.body as { data: { id: string } }).data.id;

      const fromAda = await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'Are you there?' })
        .expect(403);
      expect(refusal(fromAda).reason).toEqual({ code: 'chat_blocked' });
      expect(refusal(fromAda).message).toBe(
        'You can no longer message this person.',
      );

      const fromBola = await as(bola)
        .post(`/chats/${chatId}/messages`, { text: 'Bye' })
        .expect(403);
      expect(refusal(fromBola).reason).toEqual({ code: 'chat_blocked' });

      await as(ada).post('/chats', { wawuId: bola.sub }).expect(403);
      await as(ada)
        .post(`/chats/${chatId}/attachments`, {
          contentType: 'image/jpeg',
          contentLength: 10,
        })
        .expect(403);
      expect(
        await prisma.chatMessage.count({
          where: {
            conversationId: chatId,
            text: { in: ['Are you there?', 'Bye'] },
          },
        }),
      ).toBe(0);
    });

    it('the history stays readable, and the chat says it cannot take messages', async () => {
      const page = await as(ada).get(`/chats/${chatId}/messages`).expect(200);
      expect(messages(page).items.length).toBeGreaterThan(0);
      expect(chat(await as(ada).get(`/chats/${chatId}`)).canMessage).toBe(
        false,
      );
      expect(chat(await as(bola).get(`/chats/${chatId}`)).canMessage).toBe(
        false,
      );
    });

    it('after the block is lifted they can chat again', async () => {
      await as(bola).del(`/settings/privacy/blocked/${blockId}`).expect(200);
      await as(ada)
        .post(`/chats/${chatId}/messages`, { text: 'Back again' })
        .expect(201);
      expect(chat(await as(ada).get(`/chats/${chatId}`)).canMessage).toBe(true);
    });
  });
});
