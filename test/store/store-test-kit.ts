// Shared set-up for the store specs (task IAP-01): the mock WAWU ID, the Nest app with the
// store clients replaced by stand-ins, and the three people the specs use.

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as jwt from 'jsonwebtoken';
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

/**
 * The people the store specs use are made up for each spec file: a random id each, with a
 * token signed by mock-wawu-id's key. Never the seeded accounts: the specs delete the rows
 * they make for these people, and a seeded account's rows (its memberships, tier, points)
 * belong to every other spec that runs after.
 */
export const BUYER = randomUUID();
export const OTHER = randomUUID();
export const HOST = randomUUID();
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
/** A token for a person the spec made up, signed by mock-wawu-id's key (the Hub reads its public key). */
export function mintToken(sub: string): string {
  const privateKey = readFileSync(
    path.join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `store-${sub}@test.wawu.dev`,
      phone: '+2348000009927',
      firstName: 'Store',
      lastName: 'Spec',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
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
