// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { LegalAssistantAllowance } from '../../legal-intake/assistant/legal-assistant-allowance';
import { LivePublisher } from '../../live/live-publisher.service';
import { composeNotification } from '../../notification/notification-event';
import {
  LegalQuoteNoticeService,
  quoteLine,
} from '../legal-quote-notice.service';

/**
 * R2-LEGAL2 (CHECK-3 H-1): a quote reaches the client's chat and
 * notifications, only for a matter that began in the app's assistant, and a
 * failure to tell never undoes the quote.
 */
const USER = '00000000-0000-4000-8000-0000000022a1';
const ADMIN = { id: '00000000-0000-4000-8000-0000000022b1' } as never;

describe('Legal quote notice (R2-LEGAL2, contract)', () => {
  let prisma: PrismaService;
  let service: LegalQuoteNoticeService;
  const emit = jest.fn();
  const publish = jest.fn();
  const module = Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    providers: [
      LegalQuoteNoticeService,
      LegalAssistantAllowance,
      { provide: NotificationService, useValue: { emit } },
      { provide: LivePublisher, useValue: { publish } },
    ],
  });
  let close: () => Promise<void>;

  async function clean() {
    const requests = await prisma.legalRequest.findMany({
      where: { wawuUserId: USER },
      select: { id: true },
    });
    await prisma.legalChatMessage.deleteMany({
      where: { legalRequestId: { in: requests.map((r) => r.id) } },
    });
    await prisma.legalIntake.deleteMany({ where: { wawuUserId: USER } });
    await prisma.legalRequest.deleteMany({ where: { wawuUserId: USER } });
  }

  async function matter(opts: {
    status?: 'quoted' | 'awaiting_quote';
    assistant?: boolean;
  }) {
    const request = await prisma.legalRequest.create({
      data: {
        wawuUserId: USER,
        serviceCode: 'property-documentation',
        serviceName: 'Property and legal document drafting',
        category: 'Property',
        path: 'consultation',
        status: opts.status ?? 'quoted',
        quoteAmount: 45000,
        consultationPaidAt: new Date(),
      },
    });
    if (opts.assistant !== false) {
      await prisma.legalIntake.create({
        data: {
          wawuUserId: USER,
          matter: 'property',
          status: 'converted',
          channel: 'assistant',
          legalRequestId: request.id,
        },
      });
    }
    return request;
  }

  beforeAll(async () => {
    const ref = await module.compile();
    prisma = ref.get(PrismaService);
    service = ref.get(LegalQuoteNoticeService);
    close = () => ref.close();
    await clean();
  }, 30000);
  beforeEach(() => {
    emit.mockReset();
    publish.mockReset();
  });
  afterEach(clean);
  afterAll(async () => {
    await clean();
    await close();
  });

  it('writes the quote into the chat as the consultant, signals the phone and notifies', async () => {
    const request = await matter({});
    await service.quoteReady(ADMIN, request.id);

    const lines = await prisma.legalChatMessage.findMany({
      where: { legalRequestId: request.id },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      authorRole: 'consultant',
      authorAdminId: (ADMIN as { id: string }).id,
      body: 'I have sent you a quote of ₦45,000. Open your request to read the agreement and sign it.',
    });
    expect(publish).toHaveBeenCalledWith({
      kind: 'legal.thread',
      legalRequestId: request.id,
      messageId: lines[0].id,
    });
    expect(emit).toHaveBeenCalledWith({
      kind: 'legal_quote_ready',
      userWawuId: USER,
      requestId: request.id,
      serviceName: 'Property and legal document drafting',
    });
  });

  it('does nothing for a matter the web started, or one that is not quoted', async () => {
    const web = await matter({ assistant: false });
    await service.quoteReady(ADMIN, web.id);
    await prisma.legalRequest.deleteMany({ where: { id: web.id } });
    const unquoted = await matter({ status: 'awaiting_quote' });
    await service.quoteReady(ADMIN, unquoted.id);
    expect(emit).not.toHaveBeenCalled();
    expect(await prisma.legalChatMessage.count()).toBe(0);
  });

  it('never throws: a failed notification leaves the quote as it was', async () => {
    const request = await matter({});
    emit.mockRejectedValueOnce(new Error('down'));
    await expect(
      service.quoteReady(ADMIN, request.id),
    ).resolves.toBeUndefined();
    const now = await prisma.legalRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(now).toMatchObject({ status: 'quoted', quoteAmount: 45000 });
  });

  it('says what is true of where the tap goes', () => {
    expect(quoteLine(1250)).toBe(
      'I have sent you a quote of ₦1,250. Open your request to read the agreement and sign it.',
    );
    const draft = composeNotification({
      kind: 'legal_quote_ready',
      userWawuId: USER,
      requestId: 'r-1',
      serviceName: 'Anything',
    });
    expect(draft).toMatchObject({
      title: 'Your quote is ready',
      body: 'Your consultant has sent you a quote. Open your request to read it and sign.',
      actionHref: '/legal/requests/r-1',
    });
    // A lock screen must not show what kind of matter someone has.
    expect(JSON.stringify(draft)).not.toContain('Anything');
  });
});
