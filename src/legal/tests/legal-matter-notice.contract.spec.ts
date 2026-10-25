// Run against a test database, always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { composeNotification } from '../../notification/notification-event';
import { PUSH_RULE } from '../../push/push-policy';
import { LegalMatterNoticeService } from '../legal-matter-notice.service';

/**
 * R2-MONEY2 (CHECK-3 money third pass, H-01): a person who left the Legal
 * conversation is told in the notification list when a consultant joins and
 * when the consultation is booked, and the tap opens the matter. Only for a
 * matter that began in the app's assistant; the web's own flow is unchanged.
 * A failure to tell never undoes what was done.
 */
const USER = '00000000-0000-4000-8000-0000000033a1';

describe('Legal matter notices (R2-MONEY2, contract)', () => {
  let prisma: PrismaService;
  let service: LegalMatterNoticeService;
  const emit = jest.fn();
  const module = Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    providers: [
      LegalMatterNoticeService,
      { provide: NotificationService, useValue: { emit } },
    ],
  });
  let close: () => Promise<void>;

  async function clean() {
    await prisma.legalIntake.deleteMany({ where: { wawuUserId: USER } });
    await prisma.legalRequest.deleteMany({ where: { wawuUserId: USER } });
  }

  async function matter(assistant = true) {
    const request = await prisma.legalRequest.create({
      data: {
        wawuUserId: USER,
        serviceCode: 'property-documentation',
        serviceName: 'Property and legal document drafting',
        category: 'Property',
        path: 'consultation',
        status: 'consultation_scheduled',
        consultationPaidAt: new Date(),
      },
    });
    if (assistant) {
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
    service = ref.get(LegalMatterNoticeService);
    close = () => ref.close();
    await clean();
  }, 30000);
  beforeEach(() => emit.mockReset());
  afterEach(clean);
  afterAll(async () => {
    await clean();
    await close();
  });

  it('tells the client a consultant joined, on a matter that began in the assistant', async () => {
    const request = await matter();
    await service.consultantJoined(request.id);
    expect(emit).toHaveBeenCalledWith({
      kind: 'legal_consultant_joined',
      userWawuId: USER,
      requestId: request.id,
      serviceName: 'Property and legal document drafting',
    });
  });

  it('tells the client the consultation is booked', async () => {
    const request = await matter();
    await service.consultationBooked(request.id);
    expect(emit).toHaveBeenCalledWith({
      kind: 'legal_consultation_booked',
      userWawuId: USER,
      requestId: request.id,
      serviceName: 'Property and legal document drafting',
    });
  });

  it('says nothing for a matter the web started or one that does not exist', async () => {
    const web = await matter(false);
    await service.consultantJoined(web.id);
    await service.consultationBooked(web.id);
    await service.consultantJoined('00000000-0000-4000-8000-000000000000');
    expect(emit).not.toHaveBeenCalled();
  });

  it('never throws: a failed notification leaves the matter as it was', async () => {
    const request = await matter();
    emit.mockRejectedValue(new Error('down'));
    await expect(service.consultantJoined(request.id)).resolves.toBeUndefined();
    await expect(
      service.consultationBooked(request.id),
    ).resolves.toBeUndefined();
    const now = await prisma.legalRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(now.status).toBe('consultation_scheduled');
  });

  it('opens the matter from the list, shows no matter name, and never buzzes the phone', () => {
    for (const kind of [
      'legal_consultant_joined',
      'legal_consultation_booked',
    ] as const) {
      const draft = composeNotification({
        kind,
        userWawuId: USER,
        requestId: 'r-1',
        serviceName: 'Anything',
      });
      expect(draft.actionHref).toBe('/legal/requests/r-1');
      expect(draft.title.length).toBeGreaterThan(0);
      expect(JSON.stringify(draft)).not.toContain('Anything');
      expect(JSON.stringify(draft)).not.toContain('—');
      expect(PUSH_RULE[kind]).toBe('hold');
    }
    expect(
      composeNotification({
        kind: 'legal_consultant_joined',
        userWawuId: USER,
        requestId: 'r-1',
        serviceName: 'x',
      }).title,
    ).toBe('A consultant joined your request');
    expect(
      composeNotification({
        kind: 'legal_consultation_booked',
        userWawuId: USER,
        requestId: 'r-1',
        serviceName: 'x',
      }).title,
    ).toBe('Your consultation is booked');
  });
});
