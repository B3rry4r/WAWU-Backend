import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { FintavaClient } from '../../fintava/fintava-client';
import { FintavaConfigError } from '../../fintava/fintava-config';
import {
  FintavaOtpSender,
  FintavaWalletProvider,
} from '../../fintava/fintava-wallet-provider';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  OTP_SENDER,
  type OtpSender,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { NuvionClient } from '../nuvion-client';
import {
  NUVION_API_VERSION,
  NUVION_CONFIG_KEYS,
  NUVION_REQUIRED_KEYS,
  NuvionConfigError,
  readNuvionSettings,
} from '../nuvion-config';
import { NuvionAdapterFactory } from '../nuvion.module';
import { NuvionOtpSender } from '../nuvion-otp-sender';
import {
  NUVION_CAPABILITIES,
  type NuvionAreas,
  NuvionWalletProvider,
} from '../nuvion-wallet-provider';

/**
 * NUV-01: WALLET_PROVIDER=nuvion boots the Nuvion adapter (no database, no
 * network: nothing here sends a request to Nuvion; the adapter's calls go
 * to the stand-in, and the outbound guard refuses anything but loopback).
 *
 * - With every Nuvion setting present the module builds the Nuvion
 *   adapter and the email code sender; a missing setting, or a base URL
 *   other than Nuvion's two hosts, stops it at boot naming the setting.
 * - Unset or `fintava` boots Fintava as before, whatever the Nuvion
 *   settings say; under nuvion a wrong FINTAVA_* value no longer stops the
 *   server (MONEY-20 finding 1), and under fintava it still does.
 * - Every WalletProvider method of the adapter is handed to its area (one
 *   file per later task) and, until that task fills it, answers
 *   `not_supported` with nothing sent.
 */

const NUVION_ENV: Record<string, string> = {
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_NUV01bootKEYnotarealkey000000',
  NUVION_WEBHOOK_SECRET: 'whsec_nuv01_boot_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
};

const TOUCHED = [
  'WALLET_PROVIDER',
  ...Object.values(NUVION_CONFIG_KEYS),
  'FINTAVA_BASE_URL',
  'FINTAVA_API_KEY',
  'FINTAVA_TIMEOUT_MS',
];

describe('NUV-01: the Nuvion adapter behind WALLET_PROVIDER', () => {
  let guard: OutboundGuard;
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    guard = guardOutbound();
    for (const k of TOUCHED) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  afterAll(() => {
    expect(guard.violations).toEqual([]);
    guard.restore();
  });

  async function boot(env: Record<string, string | undefined>) {
    for (const k of TOUCHED) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        WalletProviderModule,
      ],
    }).compile();
  }

  describe('the settings', () => {
    const get = (env: Record<string, string | undefined>) => (key: string) =>
      env[key];

    it('reads the documented hosts, the pinned version and the operational account', () => {
      const { settings, apiKey } = readNuvionSettings(get(NUVION_ENV));
      expect(settings).toMatchObject({
        baseUrl: 'https://api.nuvion.dev',
        environment: 'sandbox',
        apiVersion: '2026-02-06',
        operationalAccountId: '01HXYZOPERATIONAL000000001',
        readTimeoutMs: 15_000,
        moneyTimeoutMs: 30_000,
        checkTimeoutMs: 30_000,
        resendSafetyMs: 600_000,
        retryAfterSeconds: 30,
      });
      expect(apiKey).toBe(NUVION_ENV.NUVION_API_KEY);
      expect(
        readNuvionSettings(
          get({ ...NUVION_ENV, NUVION_BASE_URL: 'https://api.nuvion.co/' }),
        ).settings,
      ).toMatchObject({
        baseUrl: 'https://api.nuvion.co',
        environment: 'production',
      });
      expect(
        readNuvionSettings(
          get({ ...NUVION_ENV, NUVION_API_VERSION: '2026-02-06' }),
        ).settings.apiVersion,
      ).toBe(NUVION_API_VERSION);
    });

    it.each(NUVION_REQUIRED_KEYS.map((k) => [k]))(
      'a missing %s stops it, naming the setting and the rollback',
      (key) => {
        for (const blank of [undefined, '', '   ']) {
          expect(() =>
            readNuvionSettings(get({ ...NUVION_ENV, [key]: blank })),
          ).toThrow(
            `${key} must be set when WALLET_PROVIDER=nuvion. Set it, or set WALLET_PROVIDER=fintava and restart to roll back.`,
          );
        }
      },
    );

    it.each([
      ['http://api.nuvion.dev'],
      ['https://api.nuvion.dev/v1'],
      ['https://api.nuvion.dev.example.com'],
      ['https://example.com'],
      ['https://api.nuvion.dev:8443'],
      ['https://user:pass@api.nuvion.dev'],
      ['https://api.nuvion.dev?x=1'],
      ['http://127.0.0.1:5631'],
      ['https://live.fintavapay.com'],
    ])('a base URL other than the two documented hosts stops it: %s', (url) => {
      expect(() =>
        readNuvionSettings(get({ ...NUVION_ENV, NUVION_BASE_URL: url })),
      ).toThrow(
        'NUVION_BASE_URL must be https://api.nuvion.dev or https://api.nuvion.co.',
      );
    });

    it('the version is pinned: any other value stops it', () => {
      expect(() =>
        readNuvionSettings(
          get({ ...NUVION_ENV, NUVION_API_VERSION: '2026-01-01' }),
        ),
      ).toThrow('NUVION_API_VERSION is pinned to 2026-02-06');
    });

    it('a malformed operational account id, or a timeout out of range, stops it naming the setting', () => {
      expect(() =>
        readNuvionSettings(
          get({ ...NUVION_ENV, NUVION_OPERATIONAL_ACCOUNT_ID: 'acct 1; drop' }),
        ),
      ).toThrow(/^NUVION_OPERATIONAL_ACCOUNT_ID must be/);
      for (const key of [
        'NUVION_TIMEOUT_MS',
        'NUVION_MONEY_TIMEOUT_MS',
        'NUVION_CHECK_TIMEOUT_MS',
      ]) {
        for (const bad of ['abc', '10', '300001', '1.5']) {
          expect(() =>
            readNuvionSettings(get({ ...NUVION_ENV, [key]: bad })),
          ).toThrow(
            new NuvionConfigError(
              `${key} must be a whole number of milliseconds from 50 to 300000.`,
            ),
          );
        }
      }
      expect(
        readNuvionSettings(
          get({ ...NUVION_ENV, NUVION_MONEY_TIMEOUT_MS: '45000' }),
        ).settings.moneyTimeoutMs,
      ).toBe(45_000);
    });
  });

  describe('booting the seam', () => {
    it('nuvion with every setting: the Nuvion adapter and the email code sender', async () => {
      const moduleRef = await boot(NUVION_ENV);
      const provider = moduleRef.get<WalletProvider>(WALLET_PROVIDER);
      expect(provider).toBeInstanceOf(NuvionWalletProvider);
      expect(provider.name).toBe('nuvion');
      expect(provider.configured).toBe(true);
      expect(provider.capabilities).toEqual({
        selfieMatch: false,
        hostedLiveness: false,
        separateKyc: true,
        asyncAccountNumber: true,
        identityLookup: false,
      });
      expect(provider.timings).toEqual({
        readTimeoutMs: 15_000,
        moneyTimeoutMs: 30_000,
        checkTimeoutMs: 30_000,
        resendSafetyMs: 600_000,
        retryAfterSeconds: 30,
      });
      const otp = moduleRef.get<OtpSender>(OTP_SENDER);
      expect(otp).toBeInstanceOf(NuvionOtpSender);
      expect(otp.channel).toBe('email');
      // One client, the one the factory hands the areas.
      expect((provider as NuvionWalletProvider).client).toBe(
        moduleRef.get(NuvionAdapterFactory).client(),
      );
      await moduleRef.close();
    });

    it.each(NUVION_REQUIRED_KEYS.map((k) => [k]))(
      'nuvion without %s stops at boot naming it',
      async (key) => {
        await expect(boot({ ...NUVION_ENV, [key]: undefined })).rejects.toThrow(
          new NuvionConfigError(
            `${key} must be set when WALLET_PROVIDER=nuvion. Set it, or set WALLET_PROVIDER=fintava and restart to roll back.`,
          ),
        );
      },
    );

    it('nuvion with a base URL that is not Nuvion stops at boot naming it', async () => {
      await expect(
        boot({ ...NUVION_ENV, NUVION_BASE_URL: 'https://api.nuvion.example' }),
      ).rejects.toThrow(
        'NUVION_BASE_URL must be https://api.nuvion.dev or https://api.nuvion.co.',
      );
    });

    it.each([[undefined], ['fintava'], [' FINTAVA ']])(
      'WALLET_PROVIDER=%s boots Fintava as before, never reading the Nuvion settings (even wrong ones)',
      async (value) => {
        const moduleRef = await boot({
          WALLET_PROVIDER: value,
          NUVION_BASE_URL: 'https://not-nuvion.example',
          NUVION_API_VERSION: 'yesterday',
        });
        const provider = moduleRef.get<WalletProvider>(WALLET_PROVIDER);
        expect(provider).toBeInstanceOf(FintavaWalletProvider);
        expect(moduleRef.get(OTP_SENDER)).toBeInstanceOf(FintavaOtpSender);
        expect(moduleRef.get<OtpSender>(OTP_SENDER).channel).toBe('sms');
        await moduleRef.close();
      },
    );

    it('under nuvion a leftover wrong FINTAVA_* value no longer stops the server (finding 1): Fintava runs unconfigured', async () => {
      for (const bad of [
        { FINTAVA_TIMEOUT_MS: 'abc' },
        { FINTAVA_BASE_URL: 'https://example.com' },
      ]) {
        const moduleRef = await boot({ ...NUVION_ENV, ...bad });
        expect(moduleRef.get(WALLET_PROVIDER)).toBeInstanceOf(
          NuvionWalletProvider,
        );
        expect(moduleRef.get(FintavaClient).environment).toBe('unconfigured');
        await moduleRef.close();
      }
    });

    it('under fintava the same wrong FINTAVA_* value still stops the server, as before', async () => {
      await expect(boot({ FINTAVA_TIMEOUT_MS: 'abc' })).rejects.toThrow(
        FintavaConfigError,
      );
      await expect(
        boot({ FINTAVA_BASE_URL: 'https://example.com' }),
      ).rejects.toThrow(FintavaConfigError);
    });
  });

  describe('the adapter hands every method to its area', () => {
    const standin = new NuvionStandin();
    beforeAll(() => standin.start());
    afterAll(() => standin.stop());

    /** Every WalletProvider method, with arguments, and the area that owns it. */
    const CALLS: Array<[keyof WalletProvider, keyof NuvionAreas, unknown[]]> = [
      ['checkIdentity', 'opening', ['22200000001']],
      ['openWallet', 'opening', [{ firstName: 'A' }]],
      ['findCustomerByPhone', 'opening', ['+2348031234567', () => 'd']],
      ['getCustomerMatch', 'opening', ['c1', () => 'd']],
      ['listCustomerSightings', 'opening', [{ page: 1, take: 10 }]],
      ['matchSelfie', 'documents', [{ bvn: '1', imageBase64: 'x' }]],
      ['startLivenessSession', 'documents', [{ customerId: 'c1' }]],
      ['getLivenessResult', 'documents', ['s1']],
      ['submitKyc', 'documents', [{ customerId: 'c1' }]],
      ['getWalletAccount', 'accounts', ['c1']],
      ['getBalance', 'accounts', [{ walletId: 'w1' }]],
      ['getPlatformAccount', 'book', []],
      ['walletToWallet', 'book', [{ reference: 'r1', amountKobo: 100n }]],
      ['listBanks', 'payouts', []],
      [
        'checkAccountName',
        'payouts',
        [{ accountNumber: '0123456789', bankCode: '090270' }],
      ],
      ['bankTransfer', 'payouts', [{ reference: 'r2', amountKobo: 100n }]],
      ['findTransactionByReference', 'reconcile', ['r3']],
      ['findTransactionById', 'reconcile', ['t1']],
      [
        'listTransactions',
        'reconcile',
        [{ kind: 'merchant' }, { page: 1, take: 10 }],
      ],
      ['reconcileSend', 'reconcile', ['r4', { kind: 'merchant' }]],
      ['confirmMovement', 'reconcile', [{ references: ['r5'] }]],
      ['secondaryReferenceOf', 'reconcile', [{ id: 't2' }]],
    ];

    it('each method calls its own area with the same arguments, and only that area', async () => {
      const calls: string[] = [];
      const area = (name: string) =>
        new Proxy(
          {},
          {
            get: (_t, method) =>
              method === 'deliveries'
                ? {
                    ledgerEvents: [],
                    read: () => ({ kind: 'unreadable', why: name }),
                  }
                : (...args: unknown[]) => {
                    calls.push(
                      `${name}.${String(method)}(${JSON.stringify(args, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'function' ? 'fn' : v))})`,
                    );
                    return Promise.resolve(name);
                  },
          },
        );
      const areas = {
        opening: area('opening'),
        documents: area('documents'),
        accounts: area('accounts'),
        book: area('book'),
        payouts: area('payouts'),
        reconcile: area('reconcile'),
      } as unknown as NuvionAreas;
      const provider = new NuvionWalletProvider(
        new NuvionClient(standin.settings(), 'k'),
        areas,
      );
      for (const [method, owner, args] of CALLS) {
        calls.length = 0;
        const calls_ = provider as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        await calls_[method](...args);
        expect(calls).toHaveLength(1);
        expect(calls[0].startsWith(`${owner}.${method}(`)).toBe(true);
      }
      calls.length = 0;
      const clock = {
        attemptedAt: new Date(0),
        now: new Date(1),
        resendAfterMs: 1,
      };
      provider.decideRetry('bank_transfer', { state: 'absent' }, clock);
      expect(calls[0].startsWith('reconcile.decideRetry(')).toBe(true);
      expect(provider.deliveries.read('e', {}, 'r')).toEqual({
        kind: 'unreadable',
        why: 'reconcile',
      });
    });

    it('until its task fills it, every method answers not_supported (decideRetry: wait), sends nothing and says nothing moved', async () => {
      const provider = new NuvionWalletProvider(
        new NuvionClient(standin.settings(), 'nv_test_sk_k'),
      );
      expect(provider.capabilities).toEqual(NUVION_CAPABILITIES);
      // Filled by NUV-02 (its own spec, nuvion-opening.contract.spec.ts):
      // without the review details openWallet is refused before anything
      // is sent, and Nuvion keeps no phone lookup ("cannot tell").
      // Filled by NUV-03 (nuvion-documents.spec.ts): the onboarding
      // submission is a real call now, so it is not in this table of
      // "sends nothing". The hosted selfie stays not_supported until
      // NUVION_HOSTED_LIVENESS=on, and the selfie match for good.
      const FILLED: ReadonlyArray<keyof WalletProvider> = [
        'openWallet',
        'findCustomerByPhone',
        'submitKyc',
      ];
      await expect(
        provider.openWallet({ firstName: 'A' } as never),
      ).rejects.toMatchObject({ kind: 'validation', recordMayExist: false });
      await expect(
        provider.findCustomerByPhone('+2348031234567', () => 'd'),
      ).resolves.toEqual({ state: 'unknown', why: 'empty_answer' });
      // The accounts area is NUV-04's and no longer a stub (its own specs
      // cover it): every other area still answers not_supported.
      for (const [method, owner, args] of CALLS) {
        if (owner === 'accounts' || FILLED.includes(method)) continue;
        const methods = provider as unknown as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >;
        const e: unknown = await methods[method](...args).then(
          () => null,
          (err: unknown) => err,
        );
        expect(e).toBeInstanceOf(WalletProviderError);
        expect(e).toMatchObject({
          kind: 'not_supported',
          provider: 'nuvion',
          recordMayExist: false,
        });
      }
      // Pure, so no failure: the only advice is to wait (never resend,
      // never settle), whatever was found.
      const clock = {
        attemptedAt: new Date(0),
        now: new Date(),
        resendAfterMs: 0,
      };
      expect(
        provider.decideRetry('wallet_to_wallet', { state: 'absent' }, clock),
      ).toEqual({
        action: 'wait',
        why: 'pending',
      });
      expect(
        provider.decideRetry(
          'bank_transfer',
          { state: 'unknown', why: 'unreachable' },
          clock,
        ),
      ).toEqual({ action: 'wait', why: 'unreachable' });
      expect(provider.deliveries.ledgerEvents).toEqual([]);
      expect(provider.deliveries.read('inflows.completed', {}, 'x').kind).toBe(
        'unreadable',
      );
      expect(standin.seen).toEqual([]);
    });

    it('the email sender sends no text: not_supported, nothing sent', async () => {
      const sender = new NuvionOtpSender({ get: () => undefined } as never);
      await expect(sender.sendText()).rejects.toMatchObject({
        kind: 'not_supported',
        recordMayExist: false,
      });
    });
  });
});
