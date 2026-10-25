// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../../notification/notification.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { MeModule } from '../me.module';
import { MePaidPurchasesService } from '../me-paid-purchases.service';

/**
 * R2-MONEY2 (CHECK-3 money third pass, H-01): My purchases lists a legal fee
 * the person paid from the wallet, as it lists a school fee: the completed
 * wallet payment is the record, `openId` is the request, a fee paid back is
 * `refunded`, and a payment that is not completed is not a purchase. Kept
 * apart from the FIX-59 spec so that spec's exact lists stay as they were.
 */
const PERSON = '00000000-0000-4000-8000-0000000044a1';
const MARK = 'r2m2-legal-';

describe('My purchases lists legal fees (R2-MONEY2, contract)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let purchases: MePaidPurchasesService;

  async function fee(o: {
    request: string;
    title: string;
    price: number;
    at: Date;
    status?: 'completed' | 'pending';
    refunded?: boolean;
  }) {
    const id = randomUUID();
    const price = BigInt(o.price);
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: PERSON,
        kind: 'legal_fee',
        targetId: o.request,
        title: o.title,
        priceKobo: price,
        providerFeeKobo: 4000n,
        wawuFeeKobo: 0n,
        totalKobo: price + 4000n,
        payeeShareKobo: 0n,
        wawuShareKobo: price,
        customerReference: `${MARK}${id}`,
        merchantAccountNumber: '0000000000',
        provider: 'nuvion',
        status: o.status ?? 'completed',
        completedAt: o.status === 'pending' ? null : o.at,
        createdAt: o.at,
      },
    });
    if (o.refunded) {
      await prisma.walletHold.create({
        data: {
          paymentId: id,
          payerWawuUserId: PERSON,
          kind: 'legal_fee',
          targetId: o.request,
          title: o.title,
          releaseCondition: 'test',
          amountKobo: price,
          payeeShareKobo: 0n,
          wawuShareKobo: price,
          merchantAccountNumber: '0000000000',
          provider: 'nuvion',
          status: 'refunded',
          action: 'refund',
          heldAt: o.at,
          settledAt: o.at,
          refundedKobo: price,
        },
      });
    }
  }

  async function clean() {
    await prisma.walletHold.deleteMany({ where: { payerWawuUserId: PERSON } });
    await prisma.walletPayment.deleteMany({
      where: { payerWawuUserId: PERSON },
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        BlockedAccountModule,
        ContentPieceModule,
        MeModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    purchases = moduleRef.get(MePaidPurchasesService, { strict: false });
    await clean();
  }, 30000);
  afterAll(async () => {
    await clean();
    await moduleRef.close();
  });

  it('lists a paid consultation and a paid service fee, newest first, each opening its request', async () => {
    const consultation = randomUUID();
    const service = randomUUID();
    await fee({
      request: consultation,
      title: 'Property and legal document drafting consultation',
      price: 4500000,
      at: new Date('2031-01-01T00:10:00Z'),
    });
    await fee({
      request: service,
      title: 'Property and legal document drafting',
      price: 4500000,
      at: new Date('2031-01-01T00:20:00Z'),
    });
    const page = await purchases.list(PERSON, undefined, undefined, 20);
    expect(page.items.map((i) => [i.kind, i.status, i.openId])).toEqual([
      ['legal_fee', 'paid', service],
      ['legal_fee', 'paid', consultation],
    ]);
    expect(page.items[0]).toMatchObject({
      title: 'Property and legal document drafting',
      amountKobo: 4500000,
      totalKobo: 4504000,
      content: null,
      lessons: null,
      credits: null,
    });
  });

  it('marks a fee paid back as refunded and leaves out a payment that never completed', async () => {
    await clean();
    const back = randomUUID();
    await fee({
      request: back,
      title: 'Business name registration',
      price: 1500000,
      at: new Date('2031-01-01T00:30:00Z'),
      refunded: true,
    });
    await fee({
      request: randomUUID(),
      title: 'Never paid',
      price: 1500000,
      at: new Date('2031-01-01T00:40:00Z'),
      status: 'pending',
    });
    const page = await purchases.list(PERSON, undefined, undefined, 20);
    expect(page.items.map((i) => [i.kind, i.status, i.openId])).toEqual([
      ['legal_fee', 'refunded', back],
    ]);
  });
});
