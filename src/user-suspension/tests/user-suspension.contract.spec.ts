/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
// USER-SUSPEND (R-121), the moderators' side: suspend, lift and read (roles, validation, repeats, the audit trail), and a
// report that ends in a suspension (a profile `take_down`, `take_down_and_suspend` on a piece, `suspend` on a paid
// question, the notes they need). The whole Hub (AppModule), real database, mock WAWU ID.

import {
  boot,
  type Harness,
  type Who,
} from '../../../test/user-suspension/suspension-harness';

jest.setTimeout(180_000);

describe('USER-SUSPEND: the moderators', () => {
  let h: Harness;
  let ana: Who; // reports
  let zed: Who; // reported, suspended
  let kim: Who; // a second person for the report cases
  let pieceId: string;
  let dmId: string;
  const TAG = `usm${Date.now().toString().slice(-8)}`;

  const admin = (role: 'superadmin' | 'reviewer' | 'support' | 'finance') => ({
    Authorization: `Bearer ${h.admin(role)}`,
  });
  const suspend = (
    id: string,
    role: 'superadmin' | 'reviewer' | 'support' | 'finance',
    body: object,
  ) =>
    h
      .http()
      .post(`/api/hub/admin/users/${id}/suspend`)
      .set(admin(role))
      .send(body);
  const lift = (
    id: string,
    role: 'superadmin' | 'reviewer' | 'support' | 'finance',
    body: object = {},
  ) =>
    h
      .http()
      .post(`/api/hub/admin/users/${id}/lift`)
      .set(admin(role))
      .send(body);
  const read = (
    id: string,
    role: 'superadmin' | 'reviewer' | 'support' | 'finance' = 'support',
  ) => h.http().get(`/api/hub/admin/users/${id}/suspension`).set(admin(role));
  const audit = (subject: string) =>
    h.prisma.adminOpsAudit.findMany({
      where: { resource: 'user_suspension', subjectWawuId: subject },
      orderBy: { actedAt: 'asc' },
    });
  const report = async (
    reporter: Who,
    kind: string,
    targetId: string,
    reason = 'harassment',
  ) =>
    (
      await h
        .http()
        .post('/api/hub/reports')
        .set({ Authorization: `Bearer ${reporter.token}` })
        .send({ kind, targetId, reason })
        .expect(200)
    ).body.data.id as string;
  const resolve = (
    reportId: string,
    body: object,
    role: 'superadmin' | 'reviewer' | 'support' | 'finance' = 'superadmin',
  ) =>
    h
      .http()
      .post(`/api/hub/admin/reports/${reportId}/resolve`)
      .set(admin(role))
      .send(body);

  beforeAll(async () => {
    process.env.UGC_REPORT_MAIL_RETRY_MS = '5';
    h = await boot('usm');
    [ana, zed, kim] = [
      await h.person('ana'),
      await h.person('zed', 'creator'),
      await h.person('kim', 'creator'),
    ];
    pieceId = (
      await h.prisma.contentPiece.create({
        data: {
          slug: `${TAG}-p`,
          creatorWawuId: kim.sub,
          contentType: 'video',
          title: `${TAG} piece`,
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
    dmId = (
      await h.prisma.directMessage.create({
        data: {
          creatorWawuId: zed.sub,
          senderWawuId: ana.sub,
          text: `paid question ${TAG}`,
          amount: 200,
          deadlineAt: new Date(Date.now() + 86_400_000),
          flutterwaveTxRef: `${TAG}-dm`,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (h) {
      await h.prisma.dmReport.deleteMany({ where: { threadId: dmId } });
      await h.prisma.directMessage.deleteMany({ where: { id: dmId } });
      await h.prisma.adminContentReview.deleteMany({
        where: { contentId: pieceId },
      });
      await h.prisma.contentPiece.deleteMany({ where: { id: pieceId } });
      await h.cleanup();
      await h.stop();
    }
  });

  it('finance and a signed-out caller are refused on all three routes; the other three roles may act', async () => {
    for (const call of [
      () => suspend(zed.sub, 'finance', { reason: 'spam' }),
      () => lift(zed.sub, 'finance'),
      () => read(zed.sub, 'finance'),
    ]) {
      expect((await call()).status).toBe(403);
    }
    expect(
      (
        await h
          .http()
          .post(`/api/hub/admin/users/${zed.sub}/suspend`)
          .send({ reason: 'spam' })
      ).status,
    ).toBe(401);
    expect(
      (
        await h
          .http()
          .post(`/api/hub/admin/users/${zed.sub}/suspend`)
          .set({ Authorization: `Bearer ${zed.token}` })
          .send({ reason: 'spam' })
      ).status,
    ).toBe(401);
    expect(
      await h.prisma.userSuspension.count({ where: { wawuUserId: zed.sub } }),
    ).toBe(0);
  });

  it('refuses a reason outside the list, a long note, a bad id and a person who does not exist', async () => {
    expect((await suspend(zed.sub, 'support', { reason: 'rude' })).status).toBe(
      400,
    );
    expect((await suspend(zed.sub, 'support', {})).status).toBe(400);
    expect(
      (
        await suspend(zed.sub, 'support', {
          reason: 'spam',
          note: 'x'.repeat(1001),
        })
      ).status,
    ).toBe(400);
    expect(
      (await suspend('not-an-id', 'support', { reason: 'spam' })).status,
    ).toBe(400);
    const nobody = await suspend(
      '00000000-0000-4000-8000-0000000000ff',
      'support',
      { reason: 'spam' },
    );
    expect(nobody.status).toBe(404);
    expect(
      await h.prisma.userSuspension.count({ where: { wawuUserId: zed.sub } }),
    ).toBe(0);
  });

  it('suspends with a reason and a note, writes one audit row, and answers the state', async () => {
    const res = await suspend(zed.sub, 'support', {
      reason: 'harassment',
      note: 'abusive in comments',
    }).expect(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        wawuId: zed.sub,
        suspended: true,
        current: expect.objectContaining({
          reason: 'harassment',
          note: 'abusive in comments',
          liftedAt: null,
        }),
      }),
    );
    expect(res.body.data.current.suspendedBy.role).toBe('support');
    const rows = await audit(zed.sub);
    expect(rows.map((r) => r.action)).toEqual(['user_suspended']);
    expect(rows[0].detail).toEqual(
      expect.objectContaining({
        reason: 'harassment',
        note: 'abusive in comments',
      }),
    );
    expect(rows[0].actedByAdminEmail).toBe('usm-support@admin.test.wawu.dev');
  });

  it('a second moderator suspending the same person changes nothing and writes no second row', async () => {
    const res = await suspend(zed.sub, 'reviewer', { reason: 'spam' }).expect(
      200,
    );
    expect(res.body.data.history).toHaveLength(1);
    expect(res.body.data.current.reason).toBe('harassment');
    expect(
      await h.prisma.userSuspension.count({ where: { wawuUserId: zed.sub } }),
    ).toBe(1);
    expect((await audit(zed.sub)).length).toBe(1);
  });

  it('is readable by the three roles, and the person reads their own state without the note, the reason or the moderator', async () => {
    for (const role of ['superadmin', 'reviewer', 'support'] as const) {
      expect((await read(zed.sub, role).expect(200)).body.data.suspended).toBe(
        true,
      );
    }
    const mine = await h
      .http()
      .get('/api/hub/me/suspension')
      .set({ Authorization: `Bearer ${zed.token}` })
      .expect(200);
    expect(mine.body.data).toEqual({
      suspended: true,
      since: expect.any(String),
      message: 'Your account is suspended. Contact support@wawuafrica.com.',
      supportEmail: 'support@wawuafrica.com',
    });
    const other = await h
      .http()
      .get('/api/hub/me/suspension')
      .set({ Authorization: `Bearer ${ana.token}` })
      .expect(200);
    expect(other.body.data).toEqual({
      suspended: false,
      since: null,
      message: '',
      supportEmail: 'support@wawuafrica.com',
    });
    expect((await h.http().get('/api/hub/me/suspension')).status).toBe(401);
  });

  it('lifts it: one audit row, safe to repeat, the history stays', async () => {
    const res = await lift(zed.sub, 'reviewer', {
      note: 'appeal upheld',
    }).expect(200);
    expect(res.body.data.suspended).toBe(false);
    expect(res.body.data.history).toHaveLength(1);
    expect(res.body.data.history[0]).toEqual(
      expect.objectContaining({ liftNote: 'appeal upheld' }),
    );
    expect(res.body.data.history[0].liftedBy.role).toBe('reviewer');
    await lift(zed.sub, 'superadmin').expect(200);
    expect((await audit(zed.sub)).map((r) => r.action)).toEqual([
      'user_suspended',
      'user_suspension_lifted',
    ]);
    expect(
      (
        await h
          .http()
          .get('/api/hub/me/suspension')
          .set({ Authorization: `Bearer ${zed.token}` })
      ).body.data.suspended,
    ).toBe(false);
  });

  it('suspends again after a lift as a new suspension, with both in the history', async () => {
    const res = await suspend(zed.sub, 'superadmin', {
      reason: 'other',
    }).expect(200);
    expect(res.body.data.history).toHaveLength(2);
    expect(res.body.data.current.reason).toBe('other');
    await lift(zed.sub, 'superadmin').expect(200);
  });

  describe('a report that ends in a suspension', () => {
    it('take_down on a reported PROFILE suspends the person (it used to answer 409), and needs a note', async () => {
      const id = await report(ana, 'profile', zed.sub);
      expect((await resolve(id, { action: 'take_down' })).status).toBe(409);
      expect(
        await h.prisma.userSuspension.count({
          where: { wawuUserId: zed.sub, liftedAt: null },
        }),
      ).toBe(0);
      const done = await resolve(id, {
        action: 'take_down',
        note: 'impersonating a creator',
        suspendReason: 'impersonation',
      }).expect(200);
      expect(done.body.data).toEqual(
        expect.objectContaining({ status: 'actioned', suspended: true }),
      );
      const row = await h.prisma.userSuspension.findFirstOrThrow({
        where: { wawuUserId: zed.sub, liftedAt: null },
      });
      expect(row).toEqual(
        expect.objectContaining({
          reason: 'impersonation',
          reportId: id,
          note: 'impersonating a creator',
        }),
      );
      expect(
        (await h.prisma.ugcReport.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('actioned');
      await lift(zed.sub, 'support').expect(200);
    });

    it('the queue says whether the person is suspended and whether they can be', async () => {
      const id = await report(kim, 'profile', zed.sub, 'spam'); // a second reporter: ana's report on this profile is settled
      const row = async () =>
        (
          (
            await h
              .http()
              .get('/api/hub/admin/reports?perPage=100')
              .set(admin('support'))
              .expect(200)
          ).body.data as Array<Record<string, unknown>>
        ).find((r) => r.id === id);
      expect(await row()).toEqual(
        expect.objectContaining({ subjectSuspended: false, canSuspend: true }),
      );
      await suspend(zed.sub, 'support', { reason: 'spam' }).expect(200);
      expect(await row()).toEqual(
        expect.objectContaining({ subjectSuspended: true, canSuspend: false }),
      );
      await lift(zed.sub, 'support').expect(200);
      await resolve(id, { action: 'dismiss' }).expect(200);
    });

    it("take_down_and_suspend on a piece removes it AND suspends whoever made it; the reason defaults to the report's", async () => {
      const id = await report(ana, 'piece', pieceId, 'sexual');
      const done = await resolve(id, {
        action: 'take_down_and_suspend',
        note: 'explicit',
      }).expect(200);
      expect(done.body.data).toEqual(
        expect.objectContaining({ status: 'actioned', suspended: true }),
      );
      expect(
        (
          await h.prisma.contentPiece.findUniqueOrThrow({
            where: { id: pieceId },
          })
        ).status,
      ).toBe('removed');
      expect(
        (
          await h.prisma.userSuspension.findFirstOrThrow({
            where: { wawuUserId: kim.sub, liftedAt: null },
          })
        ).reason,
      ).toBe('sexual');
      await lift(kim.sub, 'support').expect(200);
    });

    it('take_down alone on a piece still only removes it; dismiss suspends nobody', async () => {
      const piece2 = (
        await h.prisma.contentPiece.create({
          data: {
            slug: `${TAG}-p2`,
            creatorWawuId: kim.sub,
            contentType: 'video',
            title: `${TAG} p2`,
            description: 'x',
            category: 'fixture',
            accessType: 'paid',
            price: 100,
            previewAssetUrl: 'https://example.invalid/p.jpg',
            status: 'live',
          },
          select: { id: true },
        })
      ).id;
      const id = await report(ana, 'piece', piece2);
      const done = await resolve(id, {
        action: 'take_down',
        note: 'spam',
      }).expect(200);
      expect(done.body.data.suspended).toBe(false);
      expect(
        await h.prisma.userSuspension.count({
          where: { wawuUserId: kim.sub, liftedAt: null },
        }),
      ).toBe(0);
      await h.prisma.adminContentReview.deleteMany({
        where: { contentId: piece2 },
      });
      await h.prisma.contentPiece.deleteMany({ where: { id: piece2 } });
    });

    it("a paid question cannot be removed (409) but its sender's target can be suspended, and the question is left as it is", async () => {
      const id = await report(ana, 'direct_message', dmId, 'harassment');
      expect(
        (await resolve(id, { action: 'take_down', note: 'x' })).status,
      ).toBe(409);
      expect(
        (await resolve(id, { action: 'take_down_and_suspend', note: 'x' }))
          .status,
      ).toBe(409);
      expect((await resolve(id, { action: 'suspend' })).status).toBe(409); // a note is needed
      const done = await resolve(id, {
        action: 'suspend',
        note: 'abusive replies',
      }).expect(200);
      expect(done.body.data.suspended).toBe(true);
      expect(await h.prisma.directMessage.count({ where: { id: dmId } })).toBe(
        1,
      );
      await lift(zed.sub, 'support').expect(200);
    });

    it('a settled report is not acted on twice, and support (who cannot resolve) is refused', async () => {
      const id = await report(ana, 'profile', kim.sub);
      expect(
        (await resolve(id, { action: 'suspend', note: 'x' }, 'support')).status,
      ).toBe(403);
      await resolve(
        id,
        { action: 'suspend', note: 'first' },
        'reviewer',
      ).expect(200);
      const again = await resolve(
        id,
        { action: 'suspend', note: 'second' },
        'superadmin',
      ).expect(200);
      expect(again.body.data.resolved).toBe(0);
      expect(
        await h.prisma.userSuspension.count({
          where: { wawuUserId: kim.sub, liftedAt: null },
        }),
      ).toBe(1);
      await lift(kim.sub, 'support').expect(200);
    });
  });
});
