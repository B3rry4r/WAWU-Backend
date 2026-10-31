/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
// USER-SUSPEND (R-121), the write guard. A suspended person cannot post, comment, message, sell, tip or buy: every write is
// refused in words (403, `reason.code` account_suspended), BEFORE the body is looked at. They can still read, export their
// data, delete their account, and reach their own money. Everyone else is untouched, and lifting restores the writes.
// The whole Hub (AppModule), the real database, the mock WAWU ID. People are registered per run and removed after.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SUSPENDED_MESSAGE,
  WRITES_ALLOWED_WHILE_SUSPENDED,
  writeAllowedWhileSuspended,
} from '../../common/suspension/user-suspension';
import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';

jest.setTimeout(120_000);

describe('USER-SUSPEND: the write guard', () => {
  let h: Harness;
  let zed: Who; // suspended
  let amy: Who; // the control
  let pieceId: string;
  let zedId: string;

  const as = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const send = (
    w: Who,
    method: 'post' | 'put' | 'patch' | 'delete',
    url: string,
    body: object = {},
  ) => h.http()[method](`/api/hub${url}`).set(as(w)).send(body);
  const isSuspendedRefusal = (res: {
    status: number;
    body: { reason?: { code?: string } };
  }) => res.status === 403 && res.body.reason?.code === 'account_suspended';

  beforeAll(async () => {
    h = await boot('usw');
    zed = await h.person('zed', 'creator');
    amy = await h.person('amy');
    zedId = zed.sub;
    pieceId = (
      await h.prisma.contentPiece.create({
        data: {
          slug: `usw-${Date.now()}`,
          creatorWawuId: amy.sub,
          contentType: 'video',
          title: 'usw fixture',
          description: 'fixture',
          category: 'fixture',
          accessType: 'paid',
          price: 100,
          previewAssetUrl: 'https://example.invalid/p.jpg',
          status: 'live',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (h) {
      await h.prisma.contentPiece.deleteMany({ where: { id: pieceId } });
      await h.cleanup();
      await h.stop();
    }
  });

  it('before the suspension, the writes are not refused for anyone', async () => {
    const res = await send(zed, 'post', `/content/${pieceId}/comments`, {
      text: 'hello before',
    });
    expect(isSuspendedRefusal(res)).toBe(false);
  });

  it('a moderator suspends them', async () => {
    await h
      .http()
      .post(`/api/hub/admin/users/${zedId}/suspend`)
      .set({ Authorization: `Bearer ${h.admin('reviewer')}` })
      .send({ reason: 'harassment', note: 'write guard spec' })
      .expect(200);
  });

  it('refuses a comment, a post, a message, a follow, a tip, an upload, a report and a payment, in words and before the body is read', async () => {
    const attempts: Array<
      [string, 'post' | 'put' | 'patch' | 'delete', string]
    > = [
      ['comment', 'post', `/content/${pieceId}/comments`],
      ['create a piece', 'post', '/content'],
      ['community message', 'post', `/communities/${pieceId}/messages`],
      ['open a chat', 'post', '/chats'],
      ['send a chat message', 'post', `/chats/${pieceId}/messages`],
      ['paid question', 'post', `/dm/${amy.sub}/send`],
      ['follow', 'post', `/creators/${amy.sub}/follow`],
      ['like', 'post', `/content/${pieceId}/like`],
      ['tip', 'post', '/tips'],
      ['tip from the wallet', 'post', '/tips/wallet'],
      [
        'buy a piece from the wallet',
        'post',
        `/content/${pieceId}/unlock/wallet`,
      ],
      ['upload', 'post', '/uploads/presign'],
      ['edit the profile', 'patch', '/users/me'],
      ['report someone', 'post', '/reports'],
      ['send money to a person', 'post', '/money/transfers/wawu'],
      ['pay', 'post', '/money/payments'],
      ['buy points', 'post', '/credits/purchase/wallet'],
      ['store purchase', 'post', '/store/purchases'],
      ['block', 'post', '/settings/privacy/blocked'],
      ['create an event', 'post', '/events'],
    ];
    // These five sit behind the wallet gate, a route guard, and guards run before the write guard (an interceptor): a
    // suspended person with no wallet is told to open one. They cannot do the thing either way; the next test, on a
    // live stack with a funded wallet, shows the suspended refusal on them.
    const behindWalletGate = new Set([
      '/tips/wallet',
      '/money/transfers/wawu',
      '/money/payments',
      '/credits/purchase/wallet',
    ]);
    const bad: string[] = [];
    for (const [name, method, url] of attempts) {
      const res = await send(zed, method, url, {});
      const gate =
        (behindWalletGate.has(url) || url.endsWith('/unlock/wallet')) &&
        res.status === 409 &&
        /wallet/i.test(String(res.body.message));
      if (gate) continue;
      if (!isSuspendedRefusal(res) || res.body.message !== SUSPENDED_MESSAGE) {
        bad.push(
          `${name} ${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`,
        );
      }
    }
    expect(bad).toEqual([]);
    expect(SUSPENDED_MESSAGE).toBe(
      'Your account is suspended. Contact support@wawuafrica.com.',
    );
    expect(SUSPENDED_MESSAGE).not.toMatch(/[—–]/);
  });

  it("nobody else can message, tip or follow the suspended person (the block's neutral words)", async () => {
    const chat = await send(amy, 'post', '/chats', {
      otherWawuId: zedId,
      userWawuId: zedId,
      wawuId: zedId,
    });
    expect([400, 403]).toContain(chat.status);
    const follow = await send(amy, 'post', `/creators/${zedId}/follow`);
    expect(follow.status).toBe(403);
    expect(follow.body.reason?.code).not.toBe('account_suspended'); // the neutral refusal, not the suspended person's
  });

  it('still lets them read their own data, and the Hub says they are suspended', async () => {
    for (const url of [
      '/me/counts',
      '/me/saved',
      '/notifications',
      '/me/suspension',
    ]) {
      const res = await h.http().get(`/api/hub${url}`).set(as(zed));
      expect([url, res.status]).toEqual([url, 200]);
    }
    const mine = await h.http().get('/api/hub/me/suspension').set(as(zed));
    expect(mine.body.data).toEqual(
      expect.objectContaining({
        suspended: true,
        supportEmail: 'support@wawuafrica.com',
        message: SUSPENDED_MESSAGE,
      }),
    );
    expect(JSON.stringify(mine.body)).not.toContain('write guard spec');
  });

  it('lets through the writes that get them out: export, delete the account (and take it back), push token, notification read, their own money', async () => {
    const wrongly: string[] = [];
    for (const [method, url] of [
      ['post', '/settings/privacy/export'],
      ['post', '/push-tokens'],
      ['post', '/notifications/mark-all-read'],
      ['post', '/wallet/withdraw'],
      ['post', '/money/transfers/bank'],
      ['post', '/money/banks/name-check'],
      ['post', '/money/pin/verify'],
      ['post', '/money/wallet/open'],
      ['post', '/policies/accept'],
      ['post', `/content/${pieceId}/view`],
      ['delete', '/account'],
      ['post', '/account/cancel-deletion'],
    ] as Array<['post' | 'delete', string]>) {
      const res = await send(zed, method, url, {});
      if (isSuspendedRefusal(res))
        wrongly.push(`${method.toUpperCase()} ${url}`);
    }
    expect(wrongly).toEqual([]);
  });

  it('for a person who is not suspended the same writes answer as they always did', async () => {
    const res = await send(amy, 'post', `/content/${pieceId}/comments`, {
      text: 'amy is fine',
    });
    expect(isSuspendedRefusal(res)).toBe(false);
    expect(res.status).toBeLessThan(500);
  });

  it('a webhook (no person) and an admin call are not touched', async () => {
    const hook = await h.http().post('/api/hub/webhooks/flutterwave').send({});
    expect(isSuspendedRefusal(hook)).toBe(false);
    const admin = await h
      .http()
      .post(`/api/hub/admin/users/${zedId}/lift`)
      .set({ Authorization: `Bearer ${h.admin('support')}` })
      .send({ note: 'done' });
    expect(admin.status).toBe(200);
  });

  it('after the lift the writes work again', async () => {
    const res = await send(zed, 'post', `/content/${pieceId}/comments`, {
      text: 'back',
    });
    expect(isSuspendedRefusal(res)).toBe(false);
    expect(res.status).toBeLessThan(300);
  });

  it('the allow list names real routes, and every other write in the contract is refused', () => {
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../../../contract/openapi.json'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const shape = (p: string) =>
      p.replace(/^\/api\/hub/, '').replace(/[{:][A-Za-z0-9_]+}?/g, ':p');
    const real = new Set<string>();
    const writes: Array<[string, string]> = [];
    for (const [path, ops] of Object.entries(contract.paths)) {
      for (const method of Object.keys(ops)) {
        if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
        real.add(`${method.toUpperCase()} ${shape(path)}`);
        writes.push([
          method.toUpperCase(),
          path.replace(/^\/api\/hub/, '').replace(/{([A-Za-z0-9_]+)}/g, ':$1'),
        ]);
      }
    }
    const missing = WRITES_ALLOWED_WHILE_SUSPENDED.filter((e) => {
      const [m, p] = e.split(' ');
      return !real.has(`${m} ${shape(p)}`);
    });
    expect(missing).toEqual([]);
    const allowed = writes.filter(([m, p]) => writeAllowedWhileSuspended(m, p));
    expect(allowed.length).toBe(WRITES_ALLOWED_WHILE_SUSPENDED.length);
    expect(writes.length - allowed.length).toBeGreaterThan(250);
  });
});
