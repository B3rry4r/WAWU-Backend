import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { MoneyError } from '../../src/money/money-error';
import { MoneyModule } from '../../src/money/money.module';
import { PayableRegistry } from '../../src/money/payments/payable-registry';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../src/wallet-provider/wallet-provider-error';
import type {
  ProviderForeignAccounts,
  ProviderFxAccount,
  ProviderFxQuote,
  ProviderFxSide,
  ProviderFxTransfer,
  ProviderFxTransferLookup,
} from '../../src/wallet-provider/wallet-provider-fx';

/**
 * What PAY-FX's two runs share: the Hub's real MoneyModule over a real
 * database with `WALLET_PROVIDER` given whichever provider the run uses (the
 * contract spec's stand-in, or the real Nuvion adapter in the dev check),
 * real RS256 tokens checked against the stand-in WAWU ID's keys, and the
 * item kinds a payment is made for. No Fintava or wawuafrica.com host is
 * called.
 */

export function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `pfx-${sub}@test.wawu.dev`,
      phone: '+2348000009918',
      firstName: 'Pay',
      lastName: 'Fx',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

export class QuietLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

/** Fee settings the owner fills in (NUV-10); spec values, kobo by band. */
export const PFX_ENV: Record<string, string> = {
  FINTAVA_BASE_URL: 'http://127.0.0.1:9',
  FINTAVA_API_KEY: 'live_test_pfx_0123456789FAKEKEY',
  FEE_QUOTE_KEY: 'pfx-fee-quote-key-0123456789abcdef0123456789',
  MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
  NUVION_FEE_BOOK_TRANSFER: '0:0',
  NUVION_FEE_BANK_PAYOUT: '0:0',
  NUVION_FEE_INFLOW: '0:0',
  PIN_LOCK_MINUTES: '',
  IDEMPOTENCY_KEY_HOURS: '',
  PAYMENT_REVIEW_AFTER_HOURS: '',
};

export interface PfxApp {
  app: INestApplication;
  moduleRef: TestingModule;
  logger: QuietLogger;
  restoreEnv: () => void;
}

/** Boots the Hub's money module on `provider`. */
export async function bootPfxApp(
  provider: unknown,
  extraEnv: Record<string, string> = {},
): Promise<PfxApp> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ...PFX_ENV, ...extraEnv })) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  const logger = new QuietLogger();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .overrideProvider(WALLET_PROVIDER)
    .useValue(provider)
    .setLogger(logger)
    .compile();
  const app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
  app.useLogger(logger);
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
  await app.listen(0, '127.0.0.1');
  return {
    app,
    moduleRef,
    logger,
    restoreEnv: () => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export const PFX_CREATOR = {
  wawuUserId: randomUUID(),
  displayName: 'Chimamanda Adichie',
  handle: 'chimamanda',
  avatarUrl: null,
  tick: 'creator' as const,
};

/**
 * The item kinds a payment is made for: a piece (`content_unlock`) priced
 * `priceKobo`, and a ticket (`event_ticket`, a held kind: its price waits in
 * WAWU's account until released or refunded). Ids start with `n-`.
 */
export function registerPfxItems(
  registry: PayableRegistry,
  priceKobo: number,
  delivered: Array<{ paymentId: string; kind: string; targetId: string }>,
  owned: Set<string>,
): void {
  for (const kind of ['content_unlock', 'event_ticket'] as const) {
    registry.register({
      kind,
      resolve: async ({ targetId, payerWawuUserId }) => {
        await Promise.resolve();
        if (owned.has(`${payerWawuUserId}:${targetId}`)) {
          throw new MoneyError('target_not_payable', 'You already own this.');
        }
        if (!targetId.startsWith('n-')) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        return {
          title: `Item ${targetId}`,
          priceKobo,
          payee: PFX_CREATOR,
        };
      },
      onCompleted: async (p) => {
        await Promise.resolve();
        owned.add(`${p.payerWawuUserId}:${p.targetId}`);
        delivered.push(p);
      },
    });
  }
}

/** Dev, 26 Oct 2026: USD to NGN 1315.440043 kobo per cent; NGN to USD 0.000741 cents per kobo. */
const SELL = 1315.440043;
const BUY = 0.000741;

export interface FakeAccount {
  accountId: string;
  entityId: string;
  currency: string;
  ban: string;
  available: bigint;
}
interface FakeQuote {
  id: string;
  from: string;
  fromMerchant: boolean;
  amountFrom: bigint;
  amountTo: bigint;
  used: boolean;
  expiresAt: Date;
}
interface FakeTransfer {
  transferId: string;
  reference: string;
  status: 'pending' | 'completed' | 'failed';
  apply: () => void;
}

const id26 = (prefix: string, n: number) =>
  `${prefix}${String(n).padStart(26 - prefix.length, '0')}`;

/** Nuvion's foreign accounts as dev answered them, in memory. */
export class FakeFx implements ProviderForeignAccounts {
  readonly currencies = ['USD', 'GBP', 'EUR'] as const;
  readonly accounts = new Map<string, FakeAccount>();
  readonly quotes = new Map<string, FakeQuote>();
  readonly transfers: FakeTransfer[] = [];
  merchantKobo = 0n;
  /** What a same-currency move (WAWU's conversion fee) delivered, by the receiver's routing number. */
  readonly collected = new Map<string, bigint>();
  /** What the next swap (either way) does. */
  mode: 'completed' | 'pending' | 'failed' | 'lost' = 'completed';
  /** Seconds a new quote is held. */
  holdSeconds = 179;
  private n = 0;
  constructor(private readonly merchantBan: string) {}

  private next(prefix: string) {
    this.n += 1;
    return id26(prefix, this.n);
  }
  open(entityId: string, currency: string, cents: bigint): FakeAccount {
    const a = {
      accountId: this.next('01FAKEACC'),
      entityId,
      currency,
      ban: `00${String(1_000_000 + this.n)}`,
      available: cents,
    };
    this.accounts.set(a.accountId, a);
    return a;
  }
  openAccount(): never {
    throw new Error('not used');
  }
  readDetails(): never {
    throw new Error('not used');
  }
  send(): never {
    throw new Error('not used');
  }
  statement(): never {
    throw new Error('not used');
  }

  readAccount(_person: unknown, accountId: string): Promise<ProviderFxAccount> {
    const a = this.accounts.get(accountId)!;
    return Promise.resolve({
      accountId,
      currency: a.currency,
      ban: a.ban,
      availableMinor: a.available,
      bookedMinor: a.available,
    });
  }

  private newQuote(
    from: string,
    fromMerchant: boolean,
    amountFrom: bigint,
    amountTo: bigint,
    rate: number,
  ): ProviderFxQuote {
    const q: FakeQuote = {
      id: this.next('01FAKEQ'),
      from,
      fromMerchant,
      amountFrom,
      amountTo,
      used: false,
      expiresAt: new Date(Date.now() + this.holdSeconds * 1000),
    };
    this.quotes.set(q.id, q);
    return {
      id: q.id,
      amountFromMinor: amountFrom,
      amountToMinor: amountTo,
      rate: String(rate),
      expiresAt: q.expiresAt,
      feeMinor: null,
    };
  }

  quote(input: {
    from: ProviderFxSide;
    amountToMinor?: bigint;
  }): Promise<ProviderFxQuote> {
    const to = input.amountToMinor!;
    const cents = BigInt(Math.ceil(Number(to) / SELL));
    return Promise.resolve(
      this.newQuote(input.from.currency, false, cents, to, SELL),
    );
  }

  quoteFromMerchant(input: {
    to: ProviderFxSide;
    amountToMinor: bigint;
  }): Promise<ProviderFxQuote> {
    const kobo = BigInt(Math.ceil(Number(input.amountToMinor) / BUY));
    return Promise.resolve(
      this.newQuote('NGN', true, kobo, input.amountToMinor, BUY),
    );
  }

  private move(
    reference: string,
    quoteId: string,
    amount: bigint,
    apply: () => void,
  ): ProviderFxTransfer {
    const q = this.quotes.get(quoteId);
    const refuse = (why: string) =>
      new WalletProviderError({
        kind: 'refused',
        provider: 'nuvion',
        operation: 'fx',
        messages: [why],
      });
    if (!q) throw refuse('no such quote');
    if (q.used) throw refuse('This FX quote has already been used.');
    if (q.amountFrom !== amount) throw refuse("The amount doesn't match.");
    if (this.mode === 'lost') {
      throw new WalletProviderError({
        kind: 'outcome_unknown',
        provider: 'nuvion',
        operation: 'fx',
        reference,
      });
    }
    q.used = true;
    const t: FakeTransfer = {
      transferId: this.next('01FAKETR'),
      reference,
      status: this.mode,
      apply,
    };
    this.transfers.push(t);
    if (t.status === 'completed') apply();
    return {
      transferId: t.transferId,
      reference,
      status: t.status,
      feeMinor: 0n,
      failureReason: t.status === 'failed' ? 'declined' : null,
    };
  }

  async swap(input: {
    reference: string;
    quoteId: string | null;
    from: ProviderFxSide;
    to: ProviderFxSide;
    amountFromMinor: bigint;
  }): Promise<ProviderFxTransfer> {
    await Promise.resolve();
    const from = this.accounts.get(input.from.accountId!)!;
    if (input.quoteId === null) {
      // A move in one currency with no quote: WAWU's conversion fee to its collector.
      from.available -= input.amountFromMinor;
      const ban = input.to.ban!;
      this.collected.set(
        ban,
        (this.collected.get(ban) ?? 0n) + input.amountFromMinor,
      );
      const t: FakeTransfer = {
        transferId: this.next('01FAKETR'),
        reference: input.reference,
        status: 'completed',
        apply: () => undefined,
      };
      this.transfers.push(t);
      return {
        transferId: t.transferId,
        reference: input.reference,
        status: 'completed',
        feeMinor: 0n,
        failureReason: null,
      };
    }
    if (from.available < input.amountFromMinor) {
      throw new WalletProviderError({
        kind: 'insufficient_funds',
        provider: 'nuvion',
        operation: 'fx',
      });
    }
    const q = this.quotes.get(input.quoteId)!;
    return this.move(
      input.reference,
      input.quoteId,
      input.amountFromMinor,
      () => {
        from.available -= input.amountFromMinor;
        if (input.to.ban === this.merchantBan) this.merchantKobo += q.amountTo;
      },
    );
  }

  async swapFromMerchant(input: {
    reference: string;
    quoteId: string;
    to: ProviderFxSide;
    amountFromMinor: bigint;
  }): Promise<ProviderFxTransfer> {
    await Promise.resolve();
    const q = this.quotes.get(input.quoteId)!;
    const to = [...this.accounts.values()].find((a) => a.ban === input.to.ban)!;
    return this.move(
      input.reference,
      input.quoteId,
      input.amountFromMinor,
      () => {
        this.merchantKobo -= input.amountFromMinor;
        to.available += q.amountTo;
      },
    );
  }

  private lookup(pred: (t: FakeTransfer) => boolean): ProviderFxTransferLookup {
    const t = this.transfers.find(pred);
    return t
      ? {
          state: 'found',
          transfer: {
            transferId: t.transferId,
            reference: t.reference,
            status: t.status,
            feeMinor: 0n,
            failureReason: null,
          },
        }
      : { state: 'absent' };
  }
  findTransferByReference(
    _p: unknown,
    _a: string,
    reference: string,
  ): Promise<ProviderFxTransferLookup> {
    return Promise.resolve(this.lookup((t) => t.reference === reference));
  }
  readTransfer(_p: unknown, id: string): Promise<ProviderFxTransferLookup> {
    return Promise.resolve(this.lookup((t) => t.transferId === id));
  }
  findMerchantTransfer(reference: string): Promise<ProviderFxTransferLookup> {
    return Promise.resolve(this.lookup((t) => t.reference === reference));
  }

  /** The provider finishes a transfer it had left pending. */
  finish(reference: string, to: 'completed' | 'failed'): void {
    const t = this.transfers.find((x) => x.reference === reference)!;
    t.status = to;
    if (to === 'completed') t.apply();
  }
}
