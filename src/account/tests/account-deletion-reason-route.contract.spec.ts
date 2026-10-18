import type { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountModule } from '../account.module';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../wawu-id-account.gateway';

/**
 * Z7's optional "Why are you leaving?" over the HTTP route (SWEEP-AUTH,
 * SETTINGS-05 L3). account-deletion-reason.contract.spec.ts drives the service
 * and the DTO pipe; this one sends the request through the real route, the
 * real guard (a signed token from the local mock WAWU ID) and the app's global
 * pipe, filter and interceptor, as the app does. The person has no wallet, so
 * no money check stands in the way. WAWU ID's gateway is a stand-in.
 */
const MOCK_WAWU_ID_BASE_URL =
  process.env.WAWU_ID_BASE_URL_TEST ?? 'http://localhost:4001';
const PLAIN_USER_IDENTIFIER = 'user@test.wawu.dev';
const PLAIN_USER_SUB = '00000000-0000-4000-8000-000000000001';

describe('DELETE /account: the leaving reason over HTTP (SETTINGS-05)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let hadPushStop = false;
  const gateway = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const server = (): Server => app.getHttpServer() as Server;
  const row = () =>
    prisma.accountDeletion.findUnique({
      where: { wawuUserId: PLAIN_USER_SUB },
    });
  const clear = () =>
    prisma.accountDeletion.deleteMany({
      where: { wawuUserId: PLAIN_USER_SUB },
    });

  beforeAll(async () => {
    const loginRes = await fetch(`${MOCK_WAWU_ID_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: PLAIN_USER_IDENTIFIER }),
    });
    if (!loginRes.ok) {
      throw new Error(`mock-wawu-id login failed (${loginRes.status})`);
    }
    accessToken = ((await loginRes.json()) as { accessToken: string })
      .accessToken;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    app.setGlobalPrefix('api/hub');
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
    hadPushStop =
      (await prisma.pushStoppedAccount.count({
        where: { userWawuId: PLAIN_USER_SUB },
      })) > 0;
    await clear();
  });

  beforeEach(async () => {
    gateway.scheduleAccountDeletion.mockClear();
    await clear();
  });

  afterAll(async () => {
    await prisma.accountDeletionContent.deleteMany({
      where: { wawuUserId: PLAIN_USER_SUB },
    });
    await clear();
    if (!hadPushStop) {
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: PLAIN_USER_SUB },
      });
    }
    await app.close();
  });

  const dataOf = (res: { body: unknown }): unknown =>
    (res.body as { data: unknown }).data;
  const send = (body?: object) => {
    const call = request(server())
      .delete('/api/hub/account')
      .set('Authorization', `Bearer ${accessToken}`);
    return body === undefined ? call : call.send(body);
  };

  it('a reason from the list in the body is kept on the deletion row', async () => {
    const res = await send({ reason: 'privacy' }).expect(200);
    expect(Object.keys(dataOf(res) as object)).toEqual(['deletionScheduledAt']);
    expect(await row()).toMatchObject({
      status: 'scheduled',
      leavingReason: 'privacy',
    });
  });

  it('no body, and an empty body, schedule the deletion with no reason stored', async () => {
    await send().expect(200);
    expect(await row()).toMatchObject({
      status: 'scheduled',
      leavingReason: null,
    });
    await clear();
    await send({}).expect(200);
    expect(await row()).toMatchObject({
      status: 'scheduled',
      leavingReason: null,
    });
  });

  it('a value outside the list, or a stray field, answers 400 and schedules nothing', async () => {
    const outside = await send({ reason: 'because I said so' }).expect(400);
    expect(dataOf(outside)).toBeNull();
    await send({ reason: '' }).expect(400);
    await send({ reason: 'privacy', note: 'x' }).expect(400);
    expect(await row()).toBeNull();
    expect(gateway.scheduleAccountDeletion).not.toHaveBeenCalled();
  });

  it('asked again while one waits over HTTP, the first reason and the date stay', async () => {
    const first = await send({ reason: 'another_account' }).expect(200);
    const second = await send({ reason: 'privacy' }).expect(200);
    expect(dataOf(second)).toEqual(dataOf(first));
    expect(await row()).toMatchObject({ leavingReason: 'another_account' });
    expect(
      await prisma.accountDeletion.count({
        where: { wawuUserId: PLAIN_USER_SUB },
      }),
    ).toBe(1);
  });
});
