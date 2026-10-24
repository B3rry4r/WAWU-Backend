// Shared set-up for the store specs (task IAP-01): the mock WAWU ID, the Nest app with the
// store clients replaced by stand-ins, and the three people the specs use.

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import {
  APP_STORE_CLIENT,
  GOOGLE_PLAY_CLIENT,
} from '../../src/store/clients/store-clients';
import { type StoreConfig, STORE_CONFIG } from '../../src/store/store-config';
import { StoreModule } from '../../src/store/store.module';
import type { StandInAppStore, StandInGooglePlay } from './store-standins';

export type Env<T> = { statusCode: number; data: T; reason?: { code: string } };
export const dataOf = <T>(res: { body: unknown }): T =>
  (res.body as Env<T>).data;
export const codeOf = (res: { body: unknown }): string | undefined =>
  (res.body as Env<unknown>).reason?.code;

export const BUYER = '00000000-0000-4000-8000-000000000001';
export const OTHER = '00000000-0000-4000-8000-000000000002';
export const HOST = '00000000-0000-4000-8000-000000000003';
export const PEOPLE = [BUYER, OTHER, HOST];

export const PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '8520';
export const MOCK = `http://localhost:${PORT}`;
export const API = '/api/hub';

export async function healthy(url: string, ms = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
export async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

export const STAND_IN_CONFIG: StoreConfig = {
  // Non-null means "the Hub holds this store's credentials"; the clients are stand-ins.
  google: {
    packageName: 'africa.wawu.test',
    serviceAccount: { client_email: 'x', private_key: 'x', token_uri: 'x' },
    apiBase: 'x',
    pubsubAudience: 'x',
    pubsubServiceAccountEmail: 'x',
    jwksUrl: 'x',
  },
  apple: {
    bundleId: 'africa.wawu.test',
    issuerId: 'x',
    keyId: 'x',
    privateKey: 'x',
    environment: 'Sandbox',
    rootCertificates: [],
    appAppleId: null,
  },
  feeBps: { android: 1500, ios: 3000 },
  accountTokenRequiredFrom: new Date('2026-10-25T00:00:00.000Z'),
};

export async function build(
  config: StoreConfig,
  google: StandInGooglePlay | null,
  apple: StandInAppStore | null,
): Promise<{ app: INestApplication; moduleRef: TestingModule }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      StoreModule,
    ],
  })
    .overrideProvider(STORE_CONFIG)
    .useValue(config)
    .overrideProvider(GOOGLE_PLAY_CLIENT)
    .useValue(google)
    .overrideProvider(APP_STORE_CLIENT)
    .useValue(apple)
    .compile();
  const app = moduleRef.createNestApplication({
    logger: process.env.IAP_LOG ? ['error'] : false,
  });
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
  return { app, moduleRef };
}

/** Starts mock-wawu-id on this spec's port when nothing answers there. */
export async function ensureMockWawuId(): Promise<ChildProcess | undefined> {
  if (await healthy(`${MOCK}/health`, 1000)) return undefined;
  const mock = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '../../mock-wawu-id'),
    env: { ...process.env, MOCK_WAWU_ID_PORT: PORT },
    stdio: 'ignore',
  });
  if (!(await healthy(`${MOCK}/health`)))
    throw new Error('mock-wawu-id not healthy');
  return mock;
}
