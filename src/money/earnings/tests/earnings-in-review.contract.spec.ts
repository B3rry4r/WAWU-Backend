import { randomUUID } from 'node:crypto';
import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdminRole } from '../../../../generated/prisma/enums';
import { AdminAuthModule } from '../../../admin/auth/admin-auth.module';
import { AdminTokenService } from '../../../admin/auth/admin-token.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdminEarningsController } from '../admin-earnings.controller';
import { EarningSettlementService } from '../earning-settlement.service';
import type {
  EarningInReviewView,
  EarningsInReviewPage,
} from '../earning-review.type';
import { EARNING_REVIEW_REASONS } from '../earning-review-reasons';
import { HOST_SHARE_KIND, hostShareReference } from '../earning-rules';
import { EarningsInReviewService } from '../earnings-in-review.service';

/**
 * OPS-26: the earnings a person has to look at, for finance
 * (`GET /admin/money/earnings/in-review`). The route is read only: it is
 * proved against a real database with rows planted in it, that the right
 * rows come back, oldest first, in cursor pages, in kobo from the row, that
 * the roles are the sweep-start route's, and that nothing was changed.
 * No provider is involved: the settlement service is a stand-in that is
 * never called by this route.
 */

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminEarningsController],
  providers: [
    EarningsInReviewService,
    { provide: EarningSettlementService, useValue: {} },
  ],
})
class UnderTestModule {}

const URL = '/api/hub/admin/money/earnings/in-review';
/** Far earlier than any row another spec leaves, so these come first. */
const T0 = new Date('2001-03-01T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const R = EARNING_REVIEW_REASONS;
/**
 * Each sentence the sweep writes on `discrepancy`: its name, what the writer
 * builds from the shared list, and the text the writers used before the list
 * existed (word for word), which must still be what is written and sent.
 */
const KNOWN: Array<[string, string, string]> = [
  [
    'a sale no longer finished',
    R.saleNotFinished.make(),
    'the sale is no longer a finished one (not completed, or under review); the earning waits for a person',
  ],
  [
    'a single earning above the cap',
    R.earningAboveCap.make(170_000n, 100_000),
    "the earning of 170000 kobo is above the cap of 100000 kobo on one move through WAWU's account",
  ],
  [
    'a move above the cap',
    R.moveAboveCap.make(2_550_000n, 2_000_000),
    "the move of 2550000 kobo is above the cap of 2000000 kobo on one move through WAWU's account",
  ],
  [
    'a refusal past the bound',
    R.refusedTooLong.make(72),
    'the wallet first refused this move 72 hours ago and it has not landed',
  ],
  [
    'a wallet that is WAWU account',
    R.sameAccount.make(),
    "the move would take money from WAWU's account to WAWU's account",
  ],
  [
    'another amount moved (Fintava)',
    R.movedOtherAmount.make('Fintava', 1_000n, 2_000n),
    'Fintava moved 1000 kobo for a move of 2000 kobo',
  ],
  [
    'another amount moved (Nuvion)',
    R.movedOtherAmount.make('Nuvion', 1_000n, 2_000n),
    'Nuvion moved 1000 kobo for a move of 2000 kobo',
  ],
  [
    'a reversal',
    R.reversed.make('Nuvion'),
    "Nuvion moved the earnings and then reversed it; WAWU's account holds the money again",
  ],
  [
    'no answer past the bound',
    R.noAnswer.make('Fintava', 24),
    'no answer from Fintava about the move after 24 hours; it may have moved',
  ],
  [
    'a charge we cannot use',
    R.chargeOnLandedMove.make('Fintava', -5n),
    'Fintava reported a charge of -5 kobo on the move',
  ],
];
const A_SENTENCE = KNOWN[3][2];
/** Texts that are not entirely ours: none of them may reach the wire. */
const CRAFTED: Array<[string, string]> = [
  [
    'a BVN-like number, a phone and a name',
    'BVN 22412345678 for Adaeze Okonkwo, phone +2348012345678',
  ],
  ['a bare BVN-like number', '22412345678'],
  ['a phone', '+2348012345678'],
  ['a hash', 'a3f5c9e17b2d4486a0f1e5d3c7b92a64'],
  ['a name', 'Adaeze Okonkwo'],
  [
    'our sentence with a name where the provider goes',
    'Adaeze Okonkwo moved 1000 kobo for a move of 2000 kobo',
  ],
  [
    'our sentence with a provider that is not ours',
    'Paystack moved 1000 kobo for a move of 2000 kobo',
  ],
  [
    'our sentence with words where an amount goes',
    "the move of 22412345678 Adaeze kobo is above the cap of 2000000 kobo on one move through WAWU's account",
  ],
  [
    'our sentence followed by a BVN-like number',
    `${A_SENTENCE}; BVN 22412345678`,
  ],
  ['a BVN-like number in front of our sentence', `22412345678; ${A_SENTENCE}`],
  ['our sentence with a name after it', `${A_SENTENCE} for Adaeze Okonkwo`],
  ['our sentence with a second line', `${A_SENTENCE}\n22412345678`],
  ['our sentence with a dangling separator', `${A_SENTENCE}; `],
  ['our sentence in capitals', A_SENTENCE.toUpperCase()],
  [
    'our sentences over a thousand characters',
    Array.from({ length: 15 }, () => A_SENTENCE).join('; '),
  ],
];

describe('Admin: earnings in review (OPS-26)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const previous: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};
  const tag = randomUUID().slice(0, 8);
  const payee = randomUUID();
  const other = randomUUID();
  const rooms: string[] = [];
  const reasonPayee = randomUUID();
  let plantEarning: (
    n: string,
    extra: Record<string, unknown>,
    who?: string,
    share?: number,
  ) => Promise<{ id: string }>;
  let ids: {
    moveA: string;
    moveB: string;
    earnA: string;
    earnB: string;
    landed: string;
    clean: string;
    inMove: string;
  };

  const http = () => request(app.getHttpServer());
  const get = (path: string, role?: AdminRole) => {
    const r = http().get(path);
    return role && tokens[role]
      ? r.set('Authorization', `Bearer ${tokens[role]}`)
      : r;
  };
  const mine = (items: EarningInReviewView[]) =>
    items.filter((i) => i.payeeWawuUserId === payee);
  const pageOf = (res: request.Response) =>
    (res.body as { data: EarningsInReviewPage }).data;

  async function everything(limit: number): Promise<EarningInReviewView[]> {
    const out: EarningInReviewView[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      const res: request.Response = await get(
        `${URL}?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        AdminRole.finance,
      ).expect(200);
      const page = pageOf(res);
      out.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return out;
    }
    throw new Error('the list never ended');
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'ops26-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'ops26-admin-refresh-secret-0123456789abcdef',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        UnderTestModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
      AdminRole.reviewer,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `ops26-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `OPS-26 ${role}`,
          role,
        },
      });
      tokens[role] = issuer.issuePair(admin).accessToken;
    }

    const move = (
      n: string,
      day: string,
      extra: Record<string, unknown>,
    ): Promise<{ id: string }> =>
      prisma.earningMove.create({
        data: {
          payeeWawuUserId: payee,
          dayKey: day,
          merchantAccountNumber: '0000000001',
          amountKobo: 1_700_000n,
          earnings: 3,
          customerReference: `ops26-${tag}-move-${n}`,
          ...extra,
        },
        select: { id: true },
      });
    /**
     * A host's share of spent credits, as an earning on its way to the
     * wallet (the source the database lets a test plant without a sale).
     */
    const earning = async (
      n: string,
      extra: Record<string, unknown>,
      who: string = payee,
      share = 170_000,
    ): Promise<{ id: string }> => {
      const room = await prisma.community.create({
        data: {
          name: `Room ${n}`,
          description: 'FIXTURE: earnings-in-review.contract.spec.ts',
          hostWawuId: who,
          kind: 'open',
        },
      });
      rooms.push(room.id);
      const spend = await prisma.creditSpend.create({
        data: {
          userWawuId: randomUUID(),
          communityId: room.id,
          creatorWawuId: who,
          creditsSpent: 12,
        },
      });
      const source = await prisma.creditSpendEarning.create({
        data: {
          creditSpendId: spend.id,
          creatorWawuId: who,
          communityId: room.id,
          creditsSpent: 12,
          creditsFunded: 12,
          grossKobo: Math.ceil(share / 0.85),
          hostShareKobo: share,
          platformShareKobo: Math.ceil(share / 0.85) - share,
          lotIds: [],
        },
      });
      return prisma.earningSettlement.create({
        data: {
          creditSpendEarningId: source.id,
          payeeWawuUserId: who,
          kind: HOST_SHARE_KIND,
          targetId: room.id,
          title: `Piece ${n}`,
          earnedAt: at(-60),
          amountKobo: BigInt(share),
          merchantAccountNumber: '0000000001',
          customerReference: hostShareReference(source.id, 1),
          ...extra,
        },
        select: { id: true },
      });
    };

    plantEarning = earning;
    // Two daily moves in review (one the wallet first refused), the older
    // first; one daily move that is not; two single earnings in review, one
    // at the same instant as a move; one landed; one clean; one in a move.
    const moveA = await move('a', '2001-02-27', {
      reviewSince: at(0),
      firstRefusedAt: at(-4320),
      amountKobo: 2_550_000n,
      earnings: 5,
      provider: 'nuvion',
      discrepancy:
        'the wallet first refused this move 72 hours ago and it has not landed',
    });
    const moveB = await move('b', '2001-02-28', {
      reviewSince: at(20),
      discrepancy: 'the move of 99999999 kobo is above the cap',
    });
    const earnA = await earning('a', {
      reviewSince: at(0),
      discrepancy:
        'the sale is no longer a finished one (not completed, or under review); the earning waits for a person',
    });
    const earnB = await earning('b', { reviewSince: at(10) }, payee, 85_000);
    const landed = await earning('landed', {
      reviewSince: at(5),
      status: 'landed',
      settledAt: at(6),
      sentAt: at(5),
      destinationAccountNumber: '0000000002',
    });
    const clean = await earning('clean', {});
    const cleanMove = await move('clean', '2001-02-26', {});
    const inMove = await earning('inmove', { moveId: moveA.id });
    // Another person's row in review: listed, but not this person's.
    await earning('other', { reviewSince: at(30) }, other, 1_000);
    ids = {
      moveA: moveA.id,
      moveB: moveB.id,
      earnA: earnA.id,
      earnB: earnB.id,
      landed: landed.id,
      clean: clean.id,
      inMove: inMove.id,
    };
    void cleanMove;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.earningSettlement.deleteMany({
        where: { payeeWawuUserId: { in: [payee, other, reasonPayee] } },
      });
      await prisma.earningMove.deleteMany({
        where: { payeeWawuUserId: { in: [payee, other, reasonPayee] } },
      });
      await prisma.community.deleteMany({ where: { id: { in: rooms } } });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('no token: 401; a bad token: 401', async () => {
    await get(URL).expect(401);
    await get(URL).set('Authorization', 'Bearer not.a.token').expect(401);
  });

  it.each([AdminRole.support, AdminRole.reviewer])(
    '%s is refused: 403',
    async (role) => {
      await get(URL, role).expect(403);
    },
  );

  it.each([AdminRole.finance, AdminRole.superadmin])(
    '%s reads the list: 200, no-store, a cursor page with a count and no total',
    async (role) => {
      const res = await get(URL, role).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = pageOf(res);
      expect(Object.keys(data).sort()).toEqual([
        'count',
        'items',
        'nextCursor',
      ]);
      expect(data.count).toBeGreaterThanOrEqual(5);
    },
  );

  it('lists the moves and earnings in review, oldest first, each in kobo from its row', async () => {
    const all = mine(await everything(100));
    // Oldest first; a daily move comes before an earning of the same moment.
    expect(all.map((i) => i.id)).toEqual([
      ids.moveA,
      ids.earnA,
      ids.earnB,
      ids.moveB,
    ]);
    const [moveA, earnA, earnB, moveB] = all;
    expect(moveA).toEqual({
      id: ids.moveA,
      kind: 'daily_move',
      payeeWawuUserId: payee,
      amountKobo: 2_550_000,
      earnings: 5,
      title: null,
      dayKey: '2001-02-27',
      provider: 'nuvion',
      firstRefusedAt: at(-4320).toISOString(),
      reviewSince: at(0).toISOString(),
      reason:
        'the wallet first refused this move 72 hours ago and it has not landed',
    });
    expect(earnA).toMatchObject({
      kind: 'earning',
      amountKobo: 170_000,
      earnings: 1,
      title: 'Piece a',
      dayKey: null,
      provider: 'fintava',
      firstRefusedAt: null,
    });
    expect(earnB).toMatchObject({ amountKobo: 85_000, reason: null });
    expect(moveB).toMatchObject({
      kind: 'daily_move',
      amountKobo: 1_700_000,
      firstRefusedAt: null,
    });
    // A landed earning, a clean one, a clean move, and an earning that
    // travels in a move in review are not listed (the move is the row).
    const listed = new Set(all.map((i) => i.id));
    for (const gone of [ids.landed, ids.clean, ids.inMove]) {
      expect(listed.has(gone)).toBe(false);
    }
  });

  it('pages by cursor without repeating or skipping a row, whatever the page size', async () => {
    for (const size of [1, 2, 3]) {
      const seen = (await everything(size)).map((i) => i.id);
      expect(new Set(seen).size).toBe(seen.length);
      const order = seen.filter((id) =>
        [ids.moveA, ids.earnA, ids.earnB, ids.moveB].includes(id),
      );
      expect(order).toEqual([ids.moveA, ids.earnA, ids.earnB, ids.moveB]);
    }
    // The first page of two is exactly the two oldest rows, and says there is more.
    const first = pageOf(
      await get(`${URL}?limit=2`, AdminRole.finance).expect(200),
    );
    expect(first.items.map((i) => i.id)).toEqual([ids.moveA, ids.earnA]);
    expect(first.nextCursor).toEqual(expect.any(String));
  });

  it('a bad limit or a cursor this list did not give: 400, a plain sentence', async () => {
    for (const q of ['limit=0', 'limit=101', 'limit=abc']) {
      const res = await get(`${URL}?${q}`, AdminRole.finance).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'limit must be a whole number from 1 to 100.',
      );
    }
    for (const c of ['nope', 'r1.', 'r1.bm90LWpzb24', `e1.${'A'.repeat(10)}`]) {
      const res = await get(`${URL}?cursor=${c}`, AdminRole.finance).expect(
        400,
      );
      expect(JSON.stringify(res.body)).toContain(
        'cursor is not one this list gave.',
      );
    }
  });

  it('is read only: no row changes and no row is added by reading every page', async () => {
    const snapshot = async () => ({
      moves: await prisma.earningMove.findMany({
        where: { payeeWawuUserId: payee },
        orderBy: { id: 'asc' },
      }),
      earnings: await prisma.earningSettlement.findMany({
        where: { payeeWawuUserId: payee },
        orderBy: { id: 'asc' },
      }),
    });
    const before = JSON.stringify(await snapshot(), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    await everything(2);
    await get(URL, AdminRole.superadmin).expect(200);
    const after = JSON.stringify(await snapshot(), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(after).toBe(before);
  });

  describe('the reason is sent only when it is our own sentence (F1)', () => {
    const planted = new Map<string, string>();
    const reasons = new Map<string, string | null>();

    beforeAll(async () => {
      let n = 0;
      const move = async (label: string, discrepancy: string) => {
        n += 1;
        const row = await prisma.earningMove.create({
          data: {
            payeeWawuUserId: reasonPayee,
            dayKey: `2001-01-${String(n).padStart(2, '0')}`,
            merchantAccountNumber: '0000000001',
            amountKobo: 1_700_000n,
            earnings: 1,
            customerReference: `ops26-${tag}-reason-${n}`,
            reviewSince: at(100 + n),
            discrepancy,
          },
          select: { id: true },
        });
        planted.set(label, row.id);
      };
      const earn = async (label: string, discrepancy: string) => {
        n += 1;
        const row = await plantEarning(
          `reason-${n}`,
          { reviewSince: at(100 + n), discrepancy },
          reasonPayee,
          1_000 + n,
        );
        planted.set(label, row.id);
      };
      for (const [name, , written] of KNOWN)
        await move(`move: ${name}`, written);
      await move(
        'move: two of our sentences',
        `${KNOWN[7][2]}; ${KNOWN[8][2]}`,
      );
      await move('move: nothing written', '');
      for (const [name, text] of CRAFTED) await move(`move: ${name}`, text);
      await earn('earning: a sale no longer finished', KNOWN[0][2]);
      await earn('earning: crafted', CRAFTED[0][1]);
      await earn('earning: our sentence with a name after it', CRAFTED[10][1]);

      const byId = new Map(
        (await everything(100))
          .filter((i) => i.payeeWawuUserId === reasonPayee)
          .map((i) => [i.id, i.reason] as const),
      );
      expect(byId.size).toBe(planted.size);
      for (const [label, id] of planted)
        reasons.set(label, byId.get(id) ?? null);
    });

    it.each(KNOWN)(
      'sends %s as the writers wrote it, word for word',
      (name, built, written) => {
        expect(built).toBe(written);
        expect(reasons.get(`move: ${name}`)).toBe(written);
      },
    );

    it('sends a note made of two of our sentences, whole', () => {
      expect(reasons.get('move: two of our sentences')).toBe(
        `${KNOWN[7][2]}; ${KNOWN[8][2]}`,
      );
    });

    it('sends a single earning in review with our sentence the same way', () => {
      expect(reasons.get('earning: a sale no longer finished')).toBe(
        KNOWN[0][2],
      );
    });

    it('sends null for a note that is not written', () => {
      expect(reasons.get('move: nothing written')).toBeNull();
    });

    it('sends null, not a part of the text, for a BVN-like number, a phone and a name', () => {
      const [, crafted] = CRAFTED[0];
      expect(
        reasons.get('move: a BVN-like number, a phone and a name'),
      ).toBeNull();
      expect(reasons.get('earning: crafted')).toBeNull();
      const wire = JSON.stringify([...reasons.values()]);
      for (const leak of [
        '22412345678',
        '+2348012345678',
        'Adaeze',
        'a3f5c9e1',
      ]) {
        expect(wire).not.toContain(leak);
      }
      expect(crafted).toContain('22412345678');
    });

    it.each(CRAFTED)('sends null for %s', (name) => {
      expect(reasons.get(`move: ${name}`)).toBeNull();
    });

    it('sends null for a single earning whose note is our sentence with more after it', () => {
      expect(
        reasons.get('earning: our sentence with a name after it'),
      ).toBeNull();
    });
  });
});
