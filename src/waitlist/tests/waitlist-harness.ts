// The harness edits an untyped copy of the plans file on purpose.
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { readFileSync } from 'node:fs';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import {
  FLUTTERWAVE_CLIENT,
  type FlutterwaveChargeInit,
  type FlutterwaveClient,
  type FlutterwaveVerifyResult,
  type InitChargeParams,
  type VerifyChargeParams,
} from '../../content-piece/flutterwave-client.interface';
import {
  parsePlansConfig,
  PLANS_CONFIG,
  PLANS_CONFIG_FILE,
  type PlansConfig,
} from '../../plans/plans-config';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import {
  WAITLIST_PAYMENT_LOOKUP,
  type WaitlistPaymentLookup,
} from '../waitlist-payment-lookup';
import { WaitlistModule } from '../waitlist.module';

/**
 * Shared by the JOIN-01 specs: the real WaitlistModule on a real database,
 * built the way src/main.ts builds the app (pipe, filter, interceptor, prefix),
 * with Flutterwave stood in at its two seams: the FlutterwaveClient the
 * browser's verify uses, and the by-reference lookup the sweep uses. Nothing
 * here, and nothing in the app under test, calls a Flutterwave host.
 */

export const DAY = 86_400_000;

/** A payment as the stood-in Flutterwave reports it. */
export interface ScriptedPayment {
  status: 'successful' | 'failed';
  /** Naira, as Flutterwave quotes it. */
  amount: number;
  currency: string;
  txRef: string;
  /** The transaction id Flutterwave reports, when it differs from the one asked about. */
  id?: string;
}

/**
 * Flutterwave, scripted. `payments` is keyed by transaction id for the
 * browser's verify; `byReference` by tx_ref for the sweep. A transaction id
 * nobody scripted throws, as the real client does for an id Flutterwave
 * does not know.
 */
export class ScriptedFlutterwave
  implements FlutterwaveClient, WaitlistPaymentLookup
{
  publicKey = 'FLWPUBK_TEST-join01-spec-X';
  readonly payments = new Map<string, ScriptedPayment>();
  readonly byReference = new Map<string, ScriptedPayment & { id: string }>();
  readonly lookupFails = new Set<string>();
  /** A transaction id whose verify answers only once its promise settles (to put one call behind another). */
  readonly holds = new Map<string, Promise<void>>();
  verifyCalls: VerifyChargeParams[] = [];
  initCalls: InitChargeParams[] = [];
  lookupCalls: string[] = [];

  initCharge(params: InitChargeParams): FlutterwaveChargeInit {
    this.initCalls.push(params);
    return {
      txRef: 'unused-by-the-waitlist',
      amount: params.amount,
      currency: 'NGN',
      publicKey: this.publicKey,
    };
  }

  verifyCharge(params: VerifyChargeParams): Promise<FlutterwaveVerifyResult> {
    this.verifyCalls.push(params);
    const p = this.payments.get(params.transactionId);
    if (!p)
      return Promise.reject(new Error('Flutterwave does not know that id'));
    return (this.holds.get(params.transactionId) ?? Promise.resolve()).then(
      () => ({
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        txRef: p.txRef,
        transactionId: p.id ?? params.transactionId,
      }),
    );
  }

  findByReference(txRef: string): Promise<FlutterwaveVerifyResult | null> {
    this.lookupCalls.push(txRef);
    if (this.lookupFails.has(txRef))
      return Promise.reject(new Error('Flutterwave is unreachable'));
    const p = this.byReference.get(txRef);
    if (!p) return Promise.resolve(null);
    return Promise.resolve({
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      txRef: p.txRef,
      transactionId: p.id,
    });
  }

  reset(): void {
    this.payments.clear();
    this.byReference.clear();
    this.lookupFails.clear();
    this.holds.clear();
    this.verifyCalls = [];
    this.initCalls = [];
    this.lookupCalls = [];
  }
}

/** The shipped plans file as untyped JSON, for a copy with one change. */
export function shippedRaw(): any {
  return JSON.parse(readFileSync(PLANS_CONFIG_FILE, 'utf8'));
}

/** The shipped file with its offers replaced by `offers`, checked as the server checks it. */
export function configWith(edit: (raw: any) => void): PlansConfig {
  const raw = shippedRaw();
  edit(raw);
  return parsePlansConfig(raw, PLANS_CONFIG_FILE);
}

export const OFFER_ID = 'event-spec';

/** A raw offer entry open from a day ago until a week from now. */
export function openOffer(over: Record<string, unknown> = {}): any {
  const now = Date.now();
  return {
    id: OFFER_ID,
    name: 'Spec event registration',
    price_kobo: 200000,
    tier: 'verify',
    tier_days: 30,
    open_from: new Date(now - DAY).toISOString(),
    open_until: new Date(now + 7 * DAY).toISOString(),
    ...over,
  };
}

export async function bootWaitlist(
  config: PlansConfig,
  fake: ScriptedFlutterwave,
  extraImports: unknown[] = [],
  extraProviders: unknown[] = [],
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule,
      AdminAuthModule,
      WaitlistModule,
      ...(extraImports as []),
    ],
    providers: [...(extraProviders as [])],
  })
    .overrideProvider(PLANS_CONFIG)
    .useValue(config)
    .overrideProvider(FLUTTERWAVE_CLIENT)
    .useValue(fake)
    .overrideProvider(WAITLIST_PAYMENT_LOOKUP)
    .useValue(fake)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: false,
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
  await app.listen(0, '127.0.0.1');
  return app;
}
