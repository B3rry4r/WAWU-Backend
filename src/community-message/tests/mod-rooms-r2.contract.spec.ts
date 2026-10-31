/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped JSON, and the money services are built bare on purpose */
// MOD-ROOMS r2 (R-122). L1: the notes and names another person reads (a tip's note, a wallet or bank transfer's note, an
// event's speakers) are refused BEFORE any money moves or any row is made. L2: a moderator's Remove on a room message sends
// the live removal event and leaves the room's log a row, as the host's delete does. The whole Hub (AppModule) over the real
// database and the mock WAWU ID, as mod-rooms.contract.spec.ts does.
//
// How "before any money moves" is proved on the wallet paths: each money service is built BARE (no dependency at all), so
// the first line that touches a ledger, a hold, a fee quote, a recipient or the provider would throw a TypeError. A refused
// note throws the filter's BadRequest instead, which can only happen if the filter ran first; a clean note gets past the
// filter and meets the tripwire.

import { BadRequestException } from '@nestjs/common';
import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';
import { LivePublisher } from '../../live/live-publisher.service';
import {
  CONTENT_BLOCKED_CODE,
  CONTENT_BLOCKED_MESSAGE,
} from '../../moderation/content-filter';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import { WalletTransferService } from '../../money/transfers/wallet-transfer.service';
import { TipWalletService } from '../../purchase/wallet/tip-wallet.service';

jest.setTimeout(240_000);

const BAD = 'you are a piece of shit';
const GOOD = 'Thank you for the jollof recipe, it was spicy and perfect.';

const refusal = (e: unknown): { code: string; message: string } => {
  expect(e).toBeInstanceOf(BadRequestException);
  const body = (e as BadRequestException).getResponse() as any;
  return { code: body.reason?.code, message: body.message };
};

/** A money service with no dependencies: touching any of them throws a TypeError. */
const bare = <T extends object>(proto: T): any => Object.create(proto);

const wallet = { wawuUserId: 'payer', accountNumber: '0000000000' } as any;
const scope = { answered: undefined } as any;

describe('MOD-ROOMS r2 (R-122)', () => {
  let h: Harness;
  let host: Who;
  let ann: Who;
  let bob: Who;
  let cat: Who;
  let roomId: string;
  const TAG = `m2${Date.now().toString().slice(-8)}`;

  const as = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const api = (path: string) => `/api/hub${path}`;
  const post = (w: Who, path: string, body: object = {}) =>
    h.http().post(api(path)).set(as(w)).send(body);
  const patch = (w: Who, path: string, body: object = {}) =>
    h.http().patch(api(path)).set(as(w)).send(body);
  const get = (w: Who, path: string) => h.http().get(api(path)).set(as(w));

  beforeAll(async () => {
    h = await boot(TAG);
    host = await h.person('host', 'creator');
    ann = await h.person('ann');
    bob = await h.person('bob');
    cat = await h.person('cat');
    roomId = (
      await h.prisma.community.create({
        data: {
          name: `${TAG} room`,
          description: 'fixture',
          hostWawuId: host.sub,
          kind: 'open',
        },
      })
    ).id;
    await h.prisma.communityMembership.createMany({
      data: [ann, bob, cat].map((p) => ({
        userWawuId: p.sub,
        communityId: roomId,
        status: 'joined' as const,
        joinedAt: new Date(),
      })),
    });
  });

  afterAll(async () => {
    await h.prisma.ugcReport.deleteMany({
      where: { targetId: { startsWith: '' }, reporterWawuId: bob.sub },
    });
    await h.prisma.communityModerationLog.deleteMany({
      where: { communityId: roomId },
    });
    await h.prisma.community.deleteMany({ where: { id: roomId } });
    await h.cleanup();
    await h.stop();
  });

  describe('L1: a note another person reads is refused before any money moves', () => {
    it('a wallet tip (and a pay-route tip, naira or foreign) with a listed word is refused first; a clean note gets past the filter', async () => {
      const tips = bare(TipWalletService.prototype);
      tips.payments = bare(WalletPaymentService.prototype);
      const dto = {
        creatorWawuId: 'creator',
        amountKobo: 100_000,
        expectedTotalKobo: 102_300,
        quoteToken: 'q',
      };
      let caught: unknown;
      try {
        await tips.tip(wallet, scope, { ...dto, note: BAD });
      } catch (e) {
        caught = e;
      }
      expect(refusal(caught)).toEqual({
        code: CONTENT_BLOCKED_CODE,
        message: CONTENT_BLOCKED_MESSAGE,
      });
      // The generic pay route, the one the tip rides on, with and without a foreign source currency.
      for (const extra of [{}, { sourceCurrency: 'USD' }]) {
        await expect(
          bare(WalletPaymentService.prototype).pay(
            wallet,
            { kind: 'tip', targetId: 'c', amountKobo: 1, note: BAD, ...extra },
            scope,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      // A clean note is not refused by the filter: it goes on and meets the tripwire (a TypeError, not a 400).
      await expect(
        tips.tip(wallet, scope, { ...dto, note: GOOD }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('a send to a person and a send to a bank account with a listed word in the note are refused first; clean notes go on', async () => {
      const svc = bare(WalletTransferService.prototype);
      for (const call of [
        () =>
          svc.send(
            wallet,
            { recipientWawuUserId: 'r', amountKobo: 1, note: BAD },
            scope,
          ),
        () =>
          svc.sendToBank(
            wallet,
            { accountNumber: '0123456789', amountKobo: 1, note: BAD },
            scope,
            { target: { accountNumber: '0123456789' } },
          ),
      ]) {
        let caught: unknown;
        try {
          await call();
        } catch (e) {
          caught = e;
        }
        expect(refusal(caught).code).toBe(CONTENT_BLOCKED_CODE);
      }
      await expect(
        svc.send(
          wallet,
          { recipientWawuUserId: 'r', amountKobo: 1, note: GOOD },
          scope,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        svc.send(wallet, { recipientWawuUserId: 'r', amountKobo: 1 }, scope),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('the web tip (Flutterwave) is refused before a charge is started or a purchase row is made', async () => {
      const before = await h.prisma.purchase.count({
        where: { buyerWawuId: ann.sub },
      });
      const res = await post(ann, '/tips', {
        creatorWawuId: host.sub,
        amount: 1000,
        note: BAD,
      });
      expect(res.status).toBe(400);
      expect(res.body.reason?.code).toBe(CONTENT_BLOCKED_CODE);
      expect(JSON.stringify(res.body)).not.toMatch(/shit/i);
      expect(
        await h.prisma.purchase.count({ where: { buyerWawuId: ann.sub } }),
      ).toBe(before);
    });

    it('a store tip carries no note at all: a note on the intent is refused by the Hub and no intent is made', async () => {
      const before = await h.prisma.storePurchaseIntent.count({
        where: { wawuUserId: ann.sub },
      });
      const res = await post(ann, '/store/intents', {
        kind: 'tip',
        platform: 'ios',
        creatorWawuId: host.sub,
        listPriceNaira: 1000,
        note: BAD,
      });
      expect(res.status).toBe(400);
      expect(
        await h.prisma.storePurchaseIntent.count({
          where: { wawuUserId: ann.sub },
        }),
      ).toBe(before);
    });

    it("an event's speaker name and role are refused on create and on edit, with nothing saved", async () => {
      const startsAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
      const base = {
        name: `${TAG} summit`,
        description: 'A clean description of the day.',
        startsAt,
        hostOrg: 'Org',
        format: 'online',
        type: 'webinar',
      };
      for (const speakers of [
        [{ name: 'Tolu Balogun', title: BAD }],
        [{ name: 'Mr Shit Head' }],
      ]) {
        const res = await post(host, '/events', { ...base, speakers });
        expect(res.status).toBe(400);
        expect(res.body.reason?.code).toBe(CONTENT_BLOCKED_CODE);
      }
      expect(await h.prisma.event.count({ where: { name: base.name } })).toBe(
        0,
      );
      const edit = await patch(
        host,
        '/events/00000000-0000-4000-8000-000000000001',
        {
          speakers: [{ name: 'Tolu', title: BAD }],
        },
      );
      expect(edit.status).toBe(400);
      expect(edit.body.reason?.code).toBe(CONTENT_BLOCKED_CODE);
    });
  });

  describe("L2: a moderator's Remove on a room message tells every open room", () => {
    it('the removal event is sent, the room log has a row (the moderator is the actor), and the catch-up carries it to a member and to nobody outside', async () => {
      const live = h.app.get(LivePublisher);
      const publish = jest.spyOn(live, 'publish');
      const start = (await get(cat, '/live/catch-up').expect(200)).body.data;
      const said = await post(ann, `/communities/${roomId}/messages`, {
        text: 'a message a moderator will take down',
      }).expect(201);
      const messageId: string = said.body.data.id;
      await post(bob, '/reports', {
        kind: 'community_message',
        targetId: messageId,
        reason: 'hate',
      }).expect(200);
      const report = await h.prisma.ugcReport.findFirstOrThrow({
        where: { targetId: messageId },
        select: { id: true },
      });
      await h
        .http()
        .post(api(`/admin/reports/${report.id}/resolve`))
        .set({ Authorization: `Bearer ${h.admin('reviewer')}` })
        .send({ action: 'take_down', note: 'hate speech' })
        .expect(200);

      expect(
        await h.prisma.communityMessage.count({ where: { id: messageId } }),
      ).toBe(0);
      expect(publish).toHaveBeenCalledWith({
        kind: 'community.message.removed',
        communityId: roomId,
        messageId,
      });
      const log = await h.prisma.communityModerationLog.findMany({
        where: { communityId: roomId, messageId },
      });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        action: 'message_deleted',
        targetWawuId: ann.sub,
        messageKind: 'text',
      });
      expect(log[0].actorWawuId.startsWith('moderator:')).toBe(true);
      expect(JSON.stringify(log[0])).not.toContain('a message a moderator');

      // A phone that was away reads the removal, in the host's and the moderator's shared log.
      const caught = (
        await get(cat, `/live/catch-up?cursor=${start.cursor}`).expect(200)
      ).body.data;
      expect(
        caught.events.some(
          (e: any) =>
            e.type === 'community.message.removed' && e.messageId === messageId,
        ),
      ).toBe(true);
      // Resolving it again removes nothing and sends nothing more.
      const calls = publish.mock.calls.length;
      await h
        .http()
        .post(api(`/admin/reports/${report.id}/resolve`))
        .set({ Authorization: `Bearer ${h.admin('reviewer')}` })
        .send({ action: 'take_down', note: 'again' });
      expect(publish.mock.calls.length).toBe(calls);
      publish.mockRestore();
    });
  });
});
