/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped JSON */
// USER-SUSPEND test harness: the whole Hub (AppModule) over the real database and the mock WAWU ID, two admins, and people
// registered per run. Not a spec.
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaService } from '../../src/common/prisma/prisma.service';

export const MOCK_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
export const MOCK = `http://localhost:${MOCK_PORT}`;
const REPO_ROOT = path.resolve(__dirname, '../../');
export const ADMIN_PASSWORD = 'user-suspend-contract-password';

export interface Who {
  sub: string;
  token: string;
}

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  http: () => request.Agent;
  stop: () => Promise<void>;
  /** A new person in the mock WAWU ID, with a Hub profile row. */
  person: (label: string, accountType?: 'user' | 'creator') => Promise<Who>;
  /** Admin tokens by role. */
  admin: (role: 'superadmin' | 'reviewer' | 'support' | 'finance') => string;
  /** Everything this harness created, removed. */
  cleanup: () => Promise<void>;
}

async function healthy(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${MOCK}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function boot(tag: string): Promise<Harness> {
  let mockId: ChildProcess | undefined;
  if (!(await healthy(1000))) {
    mockId = spawn('node', ['server.js'], {
      cwd: path.join(REPO_ROOT, 'mock-wawu-id'),
      env: { ...process.env, MOCK_WAWU_ID_PORT: MOCK_PORT },
      stdio: 'ignore',
    });
    if (!(await healthy(15000)))
      throw new Error('mock-wawu-id did not come up');
  }
  process.env.ADMIN_JWT_SECRET ??= 'user-suspend-access-secret-0123456789';
  process.env.ADMIN_JWT_REFRESH_SECRET ??=
    'user-suspend-refresh-secret-0123456789';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const app = moduleRef.createNestApplication();
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
  const prisma = moduleRef.get(PrismaService);
  const http = () => request(app.getHttpServer()) as unknown as request.Agent;

  const people: string[] = [];
  let n = 0;
  const person = async (
    label: string,
    accountType: 'user' | 'creator' = 'user',
  ) => {
    n += 1;
    const t = `${Date.now().toString().slice(-8)}${n}`;
    const res = await fetch(`${MOCK}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: `Suspend ${label}`,
        email: `suspend-${tag}-${label}-${t}@test.wawu.dev`,
        phone: `+2347${t}`,
        country: 'NG',
        password: 'not-a-real-password',
      }),
    });
    if (!res.ok) throw new Error(`register ${label} failed: ${res.status}`);
    const b = (await res.json()) as {
      accessToken: string;
      user: { id: string };
    };
    await prisma.userProfile.create({
      data: {
        wawuUserId: b.user.id,
        accountType,
        handle: `${tag}${label}${t}`.toLowerCase(),
      },
    });
    if (accountType === 'creator') {
      await prisma.creatorState
        .create({ data: { wawuUserId: b.user.id } })
        .catch(() => undefined);
    }
    people.push(b.user.id);
    return { sub: b.user.id, token: b.accessToken };
  };

  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash(ADMIN_PASSWORD);
  const roles = ['superadmin', 'reviewer', 'support', 'finance'] as const;
  const ids = Object.fromEntries(
    roles.map((r, i) => [
      r,
      `ac2${i}0000-0000-4000-8000-${tag
        .padEnd(12, '0')
        .slice(0, 12)
        .replace(/[^0-9a-f]/g, '0')}`,
    ]),
  ) as Record<(typeof roles)[number], string>;
  await prisma.adminUser.deleteMany({
    where: { id: { in: Object.values(ids) } },
  });
  await prisma.adminUser.createMany({
    data: roles.map((r) => ({
      id: ids[r],
      email: `${tag}-${r}@admin.test.wawu.dev`,
      name: `Suspend ${r}`,
      role: r,
      passwordHash,
    })),
  });
  const tokens = {} as Record<(typeof roles)[number], string>;
  for (const r of roles) {
    tokens[r] = (
      await request(app.getHttpServer())
        .post('/api/hub/admin/auth/login')
        .send({
          email: `${tag}-${r}@admin.test.wawu.dev`,
          password: ADMIN_PASSWORD,
        })
        .expect(200)
    ).body.data.accessToken as string;
  }

  return {
    app,
    prisma,
    http,
    person,
    admin: (role) => tokens[role],
    stop: async () => {
      await app.close();
      mockId?.kill();
    },
    cleanup: async () => {
      await prisma.userSuspension.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.adminOpsAudit.deleteMany({
        where: { resource: 'user_suspension', subjectWawuId: { in: people } },
      });
      await prisma.ugcReport.deleteMany({
        where: {
          OR: [
            { reporterWawuId: { in: people } },
            { subjectWawuId: { in: people } },
          ],
        },
      });
      await prisma.creatorState.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.adminUser.deleteMany({
        where: { id: { in: Object.values(ids) } },
      });
    },
  };
}
