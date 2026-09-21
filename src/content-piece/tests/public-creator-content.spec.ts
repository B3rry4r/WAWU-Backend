import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { ContentPieceModule } from '../content-piece.module';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';

/**
 * GET /content/public/creator/:wawuId/content — one creator's live work, to
 * anybody, with no session.
 *
 * WHY IT EXISTS. A shared store link (build brief C3) opens somebody's shop
 * with no session at all. The only per-creator content read was
 * GET /users/:wawuId/content, which sits on a guarded controller and 401s an
 * anonymous caller, so the store rendered identity and cross-sell over an
 * empty shelf: a page whose entire job is to sell somebody's work could not
 * show any of it.
 *
 * WHAT THIS SUITE PINS is the safety, not the happy path. An unauthenticated
 * route on a paid-content resource is exactly where a paywall leak would go
 * unnoticed, so the assertions are: it answers without a token, every piece
 * comes back LOCKED, no fullAssetUrl is ever present, and nothing that is not
 * `live` appears. If any of those inverts, this fails.
 */
describe('public creator content (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Real UUIDs: the route uses ParseUUIDPipe, as every other single-piece
  // read does, so a readable slug would 400 before reaching the service.
  const PAID_ID = '00000000-0000-4000-8000-0000000009a1';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        ContentPieceModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);

    /*
      A PAID, live piece to actually test the paywall with.

      The seeded creator's only live piece is FREE, and free content is never
      locked to anybody - so asserting "fullAssetUrl is null" over the seed
      passed for the wrong reason and would keep passing if the endpoint
      started handing paid work away. The probe row is what makes the
      assertion mean something.
    */
    await prisma.contentPiece.upsert({
      where: { id: PAID_ID },
      update: {},
      create: {
        id: PAID_ID,
        slug: 'public-paywall-probe',
        creatorWawuId: USER_CREATOR_BASIC,
        contentType: 'pdf',
        title: 'Paywall probe',
        description: 'Seeded by the public-creator-content contract spec.',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 2500,
        previewAssetUrl: 'https://example.com/preview.pdf',
        fullAssetUrl: 'https://example.com/full.pdf',
        status: 'live',
      },
    });
  });

  afterAll(async () => {
    await prisma?.contentPiece.deleteMany({ where: { id: PAID_ID } });
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  it('answers an anonymous caller with no Authorization header at all', async () => {
    const res = await http()
      .get(`/api/hub/content/public/creator/${USER_CREATOR_BASIC}/content`)
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('never unlocks anything for an anonymous caller', async () => {
    const res = await http()
      .get(`/api/hub/content/public/creator/${USER_CREATOR_BASIC}/content`)
      .query({ perPage: 100 })
      .expect(200);

    // The paywall assertion. resolveUnlockedSet(undefined, ...) returns an
    // empty set, so a PAID piece must come back locked and no piece may
    // carry the full asset. A regression here hands paid work away for free
    // to anyone with the URL.
    const pieces = res.body.data as {
      id: string;
      accessType: string;
      fullAssetUrl: string | null;
      fullAssetLocked?: boolean;
      status: string;
    }[];

    const paid = pieces.find((p) => p.id === PAID_ID);
    expect(paid).toBeDefined();
    // THE PAYWALL ASSERTION. resolveUnlockedSet(undefined, ...) returns an
    // empty set, so a paid piece must come back with no full asset. A
    // regression here hands paid work to anyone who knows the URL.
    expect(paid?.fullAssetUrl).toBeNull();

    for (const piece of pieces) {
      // Nothing pending or rejected may appear to a stranger.
      expect(piece.status).toBe('live');
      // Free content is legitimately unlocked to everybody; only paid work
      // has to be withheld.
      if (piece.accessType === 'paid') expect(piece.fullAssetUrl).toBeNull();
    }
  });

  it('serves ONE piece to an anonymous caller, still locked', async () => {
    // Build brief C3: registration belongs at checkout. Before this route a
    // visitor who followed a shared store link and tapped a piece was
    // bounced to /sign-in, so they could see that work existed and never
    // look at it.
    const res = await http()
      .get(`/api/hub/content/public/${PAID_ID}`)
      .expect(200);

    expect(res.body.data.id).toBe(PAID_ID);
    expect(res.body.data.title).toBe('Paywall probe');
    // Priced, previewable, and the body withheld. That is the whole point:
    // enough to decide with, nothing to take.
    expect(res.body.data.price).toBe(2500);
    expect(res.body.data.previewAssetUrl).toBeTruthy();
    expect(res.body.data.fullAssetUrl).toBeNull();
  });

  it('404s an anonymous caller for a piece that is not live', async () => {
    // An anonymous caller is never the owner, so findOne's own status check
    // must hide a pending submission rather than showing it to the world.
    const PENDING_ID = '00000000-0000-4000-8000-0000000009a2';
    await prisma.contentPiece.upsert({
      where: { id: PENDING_ID },
      update: { status: 'pending' },
      create: {
        id: PENDING_ID,
        slug: 'public-pending-probe',
        creatorWawuId: USER_CREATOR_BASIC,
        contentType: 'pdf',
        title: 'Not live',
        description: 'Seeded by the public-creator-content contract spec.',
        category: 'business_entrepreneurship',
        accessType: 'paid',
        price: 1000,
        previewAssetUrl: 'https://example.com/p.pdf',
        fullAssetUrl: 'https://example.com/f.pdf',
        status: 'pending',
      },
    });
    try {
      await http().get(`/api/hub/content/public/${PENDING_ID}`).expect(404);
    } finally {
      await prisma.contentPiece.deleteMany({ where: { id: PENDING_ID } });
    }
  });

  it('returns an empty list for a creator with nothing, not everybody else', async () => {
    const res = await http()
      .get('/api/hub/content/public/creator/nobody-with-this-id/content')
      .expect(200);
    expect(res.body.data).toEqual([]);
  });
});
