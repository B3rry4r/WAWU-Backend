import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FintavaClient } from '../../fintava/fintava-client';
import { FintavaError } from '../../fintava/fintava-error';
import {
  FintavaOtpSender,
  FintavaWalletProvider,
} from '../../fintava/fintava-wallet-provider';
import {
  DEFAULT_WALLET_PROVIDER,
  readWalletProviderName,
  WALLET_PROVIDER_CONFIG_KEY,
  WalletProviderConfigError,
} from '../wallet-provider-config';
import { WalletProviderError } from '../wallet-provider-error';
import {
  OTP_SENDER,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../wallet-provider.interface';
import { WalletProviderModule } from '../wallet-provider.module';

/**
 * The wallet provider seam (task MONEY-20): money code reaches a provider
 * only through `WALLET_PROVIDER` / `OTP_SENDER`, and WALLET_PROVIDER picks
 * the adapter at boot. No database, no network: nothing here sends a
 * request (the Fintava client is built against its sandbox default and
 * never called).
 */

const SRC = resolve(__dirname, '..', '..');
const MONEY = join(SRC, 'money');
const SEAM = join(SRC, 'wallet-provider');
const FINTAVA = join(SRC, 'fintava');

/** Every .ts file under `dir`, tests and specs left out. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'tests') continue;
      out.push(...sources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The files `file` imports (static, dynamic and require), resolved. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]);
  return specs
    .filter((s) => s.startsWith('.'))
    .map((s) => resolve(file, '..', s));
}

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

describe('MONEY-20: the money code imports the seam, never a provider', () => {
  it('no file under src/money (tests aside) imports anything under src/fintava', () => {
    const files = sources(MONEY);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((f) =>
      importsOf(f)
        .filter((target) => inside(target, FINTAVA))
        .map((target) => `${relative(SRC, f)} -> ${relative(SRC, target)}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no file under src/money names the Fintava client or its error and result types', () => {
    const offenders = sources(MONEY).filter((f) =>
      /\bFintava(Client|Error|ErrorKind|Transaction|Sender|Reconciliation|RetryDecision|Customer\w*|Bank\w*|Selfie\w*|BvnIdentity|Lookup)\b|\bdecideFintavaRetry\b|\bFINTAVA_(DEFAULTS|UNKNOWN_OUTCOMES|WALLET_BANK_CODE)\b/.test(
        // Comments may name Fintava (they explain history); code may not.
        readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      ),
    );
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('inside the seam, only the wiring module imports src/fintava (the adapter)', () => {
    const offenders = sources(SEAM).flatMap((f) =>
      importsOf(f)
        .filter((target) => inside(target, FINTAVA))
        .map(() => relative(SRC, f)),
    );
    expect([...new Set(offenders)]).toEqual([
      join('wallet-provider', 'wallet-provider.module.ts'),
    ]);
  });

  it('every money service that used the Fintava client injects the seam instead', () => {
    const expected: Record<string, string> = {
      'balance/wallet-balance.service.ts': 'WALLET_PROVIDER',
      'identity/wallet-identity.service.ts': 'WALLET_PROVIDER',
      'identity/selfie-match.service.ts': 'WALLET_PROVIDER',
      'opening/wallet-opening.service.ts': 'WALLET_PROVIDER',
      'saved-accounts/bank-account-check.service.ts': 'WALLET_PROVIDER',
      'ledger/ledger-status.service.ts': 'WALLET_PROVIDER',
      'ledger/ledger-consumer.service.ts': 'WALLET_PROVIDER',
      'pin/pin-reset.service.ts': 'OTP_SENDER',
    };
    for (const [file, token] of Object.entries(expected)) {
      const text = readFileSync(join(MONEY, file), 'utf8');
      expect({ file, injects: text.includes(`@Inject(${token})`) }).toEqual({
        file,
        injects: true,
      });
    }
    // The money modules import the seam's module, not FintavaModule.
    for (const file of ['money.module.ts', 'ledger/ledger.module.ts']) {
      const text = readFileSync(join(MONEY, file), 'utf8');
      expect({ file, seam: /WalletProviderModule/.test(text) }).toEqual({
        file,
        seam: true,
      });
    }
  });
});

describe('MONEY-20: WALLET_PROVIDER picks the adapter', () => {
  it('unset, blank or fintava (any case, spaces around) is fintava; nuvion is nuvion', () => {
    expect(DEFAULT_WALLET_PROVIDER).toBe('fintava');
    for (const raw of [undefined, null, '', '   ', 'fintava', ' FINTAVA ']) {
      expect(readWalletProviderName(raw)).toBe('fintava');
    }
    expect(readWalletProviderName('nuvion')).toBe('nuvion');
    expect(readWalletProviderName(' Nuvion')).toBe('nuvion');
  });

  it('any other value stops the app, naming the setting and what it may be', () => {
    for (const raw of ['flutterwave', 'fintava,nuvion', 'none', '1']) {
      expect(() => readWalletProviderName(raw)).toThrow(
        WalletProviderConfigError,
      );
      expect(() => readWalletProviderName(raw)).toThrow(
        /^WALLET_PROVIDER must be one of: fintava, nuvion/,
      );
    }
  });

  const saved = process.env[WALLET_PROVIDER_CONFIG_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[WALLET_PROVIDER_CONFIG_KEY];
    else process.env[WALLET_PROVIDER_CONFIG_KEY] = saved;
  });

  async function boot(value: string | undefined) {
    if (value === undefined) delete process.env[WALLET_PROVIDER_CONFIG_KEY];
    else process.env[WALLET_PROVIDER_CONFIG_KEY] = value;
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        WalletProviderModule,
      ],
    }).compile();
  }

  it.each([[undefined], ['fintava'], ['FINTAVA']])(
    'WALLET_PROVIDER=%s boots with the Fintava adapter over the one Fintava client',
    async (value) => {
      const moduleRef = await boot(value);
      const provider = moduleRef.get<WalletProvider>(WALLET_PROVIDER);
      expect(provider).toBeInstanceOf(FintavaWalletProvider);
      expect(provider.name).toBe('fintava');
      expect(moduleRef.get(OTP_SENDER)).toBeInstanceOf(FintavaOtpSender);
      // The adapter wraps the same client the Fintava webhook and scripts get.
      const client = moduleRef.get(FintavaClient);
      expect((provider as unknown as { client: FintavaClient }).client).toBe(
        client,
      );
      await moduleRef.close();
    },
  );

  it('WALLET_PROVIDER=nuvion stops the app with a clear message until the Nuvion adapter lands', async () => {
    await expect(boot('nuvion')).rejects.toThrow(WalletProviderConfigError);
    await expect(boot('nuvion')).rejects.toThrow(
      'WALLET_PROVIDER=nuvion is reserved: the nuvion wallet adapter is not built yet. Set WALLET_PROVIDER=fintava (or leave it unset) and restart.',
    );
  });

  it('an unknown WALLET_PROVIDER stops the app too', async () => {
    await expect(boot('flutterwave')).rejects.toThrow(
      WalletProviderConfigError,
    );
  });
});

describe('MONEY-20: the Fintava adapter changes nothing but the names', () => {
  type Stub = Partial<Record<keyof FintavaClient, unknown>>;
  const adapter = (stub: Stub) =>
    new FintavaWalletProvider(stub as unknown as FintavaClient);

  it('a FintavaError becomes a WalletProviderError of the same kind and facts', async () => {
    const original = new FintavaError({
      kind: 'outcome_unknown',
      operation: 'create customer',
      httpStatus: 504,
      messages: ['gateway timeout'],
      reference: 'REF-1',
    });
    const p = adapter({
      createCustomer: () => Promise.reject(original),
    });
    const e = await p
      .openWallet({
        firstName: 'A',
        lastName: 'B',
        phone: '08031234567',
        email: 'a@example.com',
        address: '1 Road',
        dateOfBirth: '1990-01-01',
        bvn: '22222222222',
        nin: '11111111111',
      })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WalletProviderError);
    expect(e).toMatchObject({
      kind: 'outcome_unknown',
      provider: 'fintava',
      operation: 'create customer',
      httpStatus: 504,
      messages: ['gateway timeout'],
      reference: 'REF-1',
      recordMayExist: true,
      retryAfterSeconds: 30,
    });
    expect(e).not.toBeInstanceOf(FintavaError);
  });

  it('every Fintava kind survives the translation, recordMayExist included', async () => {
    for (const kind of [
      'not_configured',
      'auth',
      'merchant_inactive',
      'validation',
      'insufficient_funds',
      'wallet_inactive',
      'duplicate_reference',
      'not_found',
      'identity_refused',
      'not_confirmed',
      'refused',
      'rate_limited',
      'unavailable',
      'outcome_unknown',
      'bad_response',
    ] as const) {
      const original = new FintavaError({ kind, operation: 'x' });
      const p = adapter({ verifyBvn: () => Promise.reject(original) });
      await expect(p.checkIdentity('22222222222')).rejects.toMatchObject({
        kind,
        recordMayExist: original.recordMayExist,
      });
    }
  });

  it('anything that is not a FintavaError passes through untouched', async () => {
    const bug = new TypeError('a bug');
    const p = adapter({ getWalletBalance: () => Promise.reject(bug) });
    await expect(p.getBalance({ walletId: 'w' })).rejects.toBe(bug);
  });

  it('amounts arrive as bigint kobo with the same digits', async () => {
    const p = adapter({
      getWalletBalance: () =>
        Promise.resolve({
          availableKobo: 4996000,
          bookedKobo: 5000000,
          tier: null,
        }),
    });
    await expect(p.getBalance({ walletId: 'w' })).resolves.toEqual({
      availableKobo: 4996000n,
      bookedKobo: 5000000n,
    });
  });

  it('what Fintava has no equivalent for answers not_supported, sending nothing', async () => {
    const p = adapter({});
    for (const call of [
      () => p.startLivenessSession({ customerId: 'c' }),
      () => p.getLivenessResult('s'),
      () =>
        p.submitKyc({
          customerId: 'c',
          firstName: 'A',
          lastName: 'B',
          dateOfBirth: '1990-01-01',
          email: 'a@example.com',
          phone: '+2348031234567',
          address: '1 Road',
          bvn: '22222222222',
          nin: '11111111111',
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        kind: 'not_supported',
        recordMayExist: false,
      });
    }
    expect(p.capabilities).toMatchObject({
      selfieMatch: true,
      hostedLiveness: false,
      separateKyc: false,
      asyncAccountNumber: false,
    });
  });

  it('configured follows the client: an unconfigured client is an unconfigured provider', () => {
    expect(adapter({ environment: 'unconfigured' }).configured).toBe(false);
    expect(adapter({ environment: 'sandbox' }).configured).toBe(true);
    expect(adapter({}).walletBankCode).toBe('090620');
  });

  it("the PIN reset's text goes through Fintava's SMS, failures translated", async () => {
    const sent: Array<[string, string]> = [];
    const ok = new FintavaOtpSender({
      environment: 'sandbox',
      sendSms: (phone: string, text: string) => {
        sent.push([phone, text]);
        return Promise.resolve();
      },
    } as unknown as FintavaClient);
    await ok.sendText('+2348031234567', 'code');
    expect(sent).toEqual([['+2348031234567', 'code']]);
    const lost = new FintavaOtpSender({
      environment: 'sandbox',
      sendSms: () =>
        Promise.reject(
          new FintavaError({ kind: 'outcome_unknown', operation: 'send SMS' }),
        ),
    } as unknown as FintavaClient);
    await expect(lost.sendText('+2348031234567', 'code')).rejects.toMatchObject(
      { kind: 'outcome_unknown', recordMayExist: true },
    );
  });
});
