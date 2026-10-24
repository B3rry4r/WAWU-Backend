import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { AdminRole } from '../../../../generated/prisma/enums';
import type { AdminUserView } from '../../../admin/auth/admin-user-view.type';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { WalletProvider } from '../../../wallet-provider/wallet-provider.interface';
import type { FxAccountsService } from '../../fx/fx-accounts.service';
import type { FxAccountView } from '../../fx/fx-view.type';
import type { FxSettings } from '../../fx/fx-settings';
import { NO_NAIRA_ACCOUNT_MESSAGE, WalletGate } from '../../gate/wallet-gate';
import { MoneyError } from '../../money-error';
import { releasedBvnHash } from '../../opening/bvn-claim';
import { WorldAdminService, worldStageOf } from '../world-admin.service';
import type { WorldSettings } from '../world-settings';
import { WorldWalletService, worldViewOf } from '../world-wallet.service';

/**
 * WALLET-41 (R-87), against a real (test) database: the first account of an
 * approved person outside Nigeria is opened once; support lists, freezes and
 * cancels with an audit row each; the wallet gate lets a world wallet reach
 * the foreign-account routes and nothing else. The provider is not called:
 * the foreign account service is a stand-in that answers as it does.
 */

jest.setTimeout(60_000);

const ADMIN: AdminUserView = {
  id: randomUUID(),
  email: 'finance@wawu.test',
  name: 'Finance',
  role: AdminRole.finance,
  status: 'active',
  lastLoginAt: null,
  createdAt: new Date(),
};

describe('WALLET-41: the world wallet', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let admin: WorldAdminService;
  let gate: WalletGate;
  let world: WorldWalletService;
  const users: string[] = [];
  let openCalls: Array<{ currency: string; customerId: string }> = [];
  let openMode: 'ok' | 'refused' | 'slow' = 'ok';
  let testDatabase = false;

  /** What the provider's own review says now, for the backstop. */
  let review: { status: string } | 'unreachable' = { status: 'pending' };
  const provider = {
    readReview: () =>
      review === 'unreachable'
        ? Promise.reject(new Error('unreachable'))
        : Promise.resolve({
            personId: null,
            status: review.status,
            bvnStatus: null,
            ninStatus: null,
            documentStatus: 'pending',
            addressProofStatus: 'pending',
            identificationStatus: 'pending',
            reasons: [],
            found: true,
            updated: Date.now(),
          }),
  } as unknown as WalletProvider;
  const fxSettings = {
    currencyOn: (c: string) => c !== 'GHS',
    productOn: () => true,
    decimalsOf: () => 2,
  } as unknown as FxSettings;
  const worldSettings = {
    suggestedFor: (c: string) => (c === 'GB' ? 'GBP' : 'USD'),
    openFeeMinor: () => 0n,
    dailyLimit: () => null,
    isBlocked: (c: string) => c === 'KP',
    openOn: () => true,
  } as unknown as WorldSettings;
  const accounts = {
    open: (
      wallet: { customerId: string },
      dto: { currency: string },
    ): Promise<FxAccountView> => {
      openCalls.push({ currency: dto.currency, customerId: wallet.customerId });
      if (openMode === 'refused') {
        return Promise.reject(
          new MoneyError('provider_declined', 'That account is not available.'),
        );
      }
      return Promise.resolve({
        id: randomUUID(),
        currency: dto.currency,
        kind: 'fiat',
        decimals: 2,
        chain: null,
        status: openMode === 'slow' ? 'opening' : 'open',
        balance: null,
        details: null,
        openedAt: new Date().toISOString(),
      } as FxAccountView);
    },
  } as unknown as FxAccountsService;

  /** A person who opened from `country`, approved or not. */
  async function person(
    country = 'US',
    over: {
      status?: string | null;
      currency?: string;
      state?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: over.state ?? 'open',
        bvnHash: `hash-${id}`,
        bvnVerifiedAt: new Date(),
        phone: `+1${id.replace(/\D/g, '').padEnd(10, '7').slice(0, 10)}${users.length}`,
        provider: 'nuvion',
        worldCountry: country,
        worldFirstCurrency: over.currency ?? 'USD',
      },
    });
    if (over.status !== null) {
      await prisma.nuvionEntity.create({
        data: {
          wawuUserId: id,
          entityId: `01ENT${id.replace(/-/g, '').toUpperCase()}`.slice(0, 26),
          status: over.status ?? 'approved',
        },
      });
    }
    return id;
  }

  beforeAll(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const res = await client.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      testDatabase = /test/.test(res.rows[0].name);
    } finally {
      await client.end();
    }
    if (!testDatabase)
      throw new Error('This spec runs only on a test database.');
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    admin = new WorldAdminService(prisma);
    gate = new WalletGate(prisma);
    world = new WorldWalletService(
      prisma,
      worldSettings,
      fxSettings,
      accounts,
      provider,
    );
  });

  beforeEach(() => {
    openCalls = [];
    openMode = 'ok';
    review = { status: 'pending' };
  });

  afterAll(async () => {
    if (testDatabase && users.length > 0) {
      await prisma.fxAccount.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.worldAdminAudit.deleteMany({
        where: { subjectWawuId: { in: users } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWalletOpening.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    await moduleRef?.close();
  });

  describe('the first account', () => {
    it('waits for Nuvion to approve, then opens in the chosen currency, once', async () => {
      const id = await person('GB', { status: 'pending', currency: 'GBP' });
      expect(await world.ensureFirstAccount(id)).toBe('waiting');
      expect(openCalls).toEqual([]);
      await prisma.nuvionEntity.update({
        where: { wawuUserId: id },
        data: { status: 'approved' },
      });
      expect(await world.ensureFirstAccount(id)).toBe('opened');
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0].currency).toBe('GBP');
      expect(await world.ensureFirstAccount(id)).toBe('already');
      expect(openCalls).toHaveLength(1);
      const row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.worldAccountOpenedAt).not.toBeNull();
    });

    it('two requests at once ask Nuvion once', async () => {
      const id = await person('US');
      const [a, b] = await Promise.all([
        world.ensureFirstAccount(id),
        world.ensureFirstAccount(id),
      ]);
      expect([a, b].sort()).toEqual(['opened', 'waiting']);
      expect(openCalls).toHaveLength(1);
    });

    it('the backstop asks the provider when no delivery came: an approval is recorded and the account opens', async () => {
      const id = await person('GB', { status: 'pending', currency: 'GBP' });
      review = { status: 'approved' };
      expect(await world.ensureFirstAccount(id)).toBe('opened');
      expect(openCalls).toHaveLength(1);
      const entity = await prisma.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(entity.status).toBe('approved');
      expect(entity.decidedAt).not.toBeNull();
      const row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.state).toBe('open');
    });

    it('the backstop leaves a review that is not approved, or a provider that cannot be asked, waiting and records nothing', async () => {
      const id = await person('GB', { status: 'pending', currency: 'GBP' });
      review = { status: 'pending' };
      expect(await world.ensureFirstAccount(id)).toBe('waiting');
      review = { status: 'rejected' };
      expect(await world.ensureFirstAccount(id)).toBe('waiting');
      review = 'unreachable';
      expect(await world.ensureFirstAccount(id)).toBe('waiting');
      const entity = await prisma.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(entity.status).toBe('pending');
      expect(openCalls).toEqual([]);
    });

    it('the backstop never approves a cancelled opening', async () => {
      const id = await person('GB', { status: 'pending', currency: 'GBP' });
      await admin.act(ADMIN, id, 'cancel', 'not who they say');
      review = { status: 'approved' };
      expect(await world.ensureFirstAccount(id)).toBe('blocked');
      expect(openCalls).toEqual([]);
    });

    it('a Nigerian opening, or none, is not a world one', async () => {
      const id = randomUUID();
      users.push(id);
      expect(await world.ensureFirstAccount(id)).toBe('not_world');
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: id,
          state: 'open',
          bvnHash: `hash-${id}`,
          bvnVerifiedAt: new Date(),
          phone: `+234${id.replace(/\D/g, '').padEnd(10, '1').slice(0, 10)}`,
          provider: 'nuvion',
        },
      });
      expect(await world.ensureFirstAccount(id)).toBe('not_world');
      expect(openCalls).toEqual([]);
    });

    it('a refusal reaches the caller in the provider words and the claim goes back, so the person can pick another currency', async () => {
      const id = await person('AE', { currency: 'AED' });
      openMode = 'refused';
      await expect(world.ensureFirstAccount(id)).rejects.toMatchObject({
        code: 'provider_declined',
      });
      let row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.worldAccountRequestedAt).toBeNull();
      expect(row.worldAccountOpenedAt).toBeNull();
      openMode = 'ok';
      expect(await world.ensureFirstAccount(id, 'USD')).toBe('opened');
      expect(openCalls.map((c) => c.currency)).toEqual(['AED', 'USD']);
      row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.worldFirstCurrency).toBe('USD');
    });

    it('a currency an admin switched off cannot be picked', async () => {
      const id = await person('GH', { currency: 'USD' });
      await expect(world.ensureFirstAccount(id, 'GHS')).rejects.toMatchObject({
        code: 'fx_switched_off',
      });
      expect(openCalls).toEqual([]);
    });

    it('an account Nuvion has not answered for is not open yet, and is asked again', async () => {
      const id = await person('US');
      openMode = 'slow';
      expect(await world.ensureFirstAccount(id)).toBe('waiting');
      openMode = 'ok';
      expect(await world.ensureFirstAccount(id)).toBe('opened');
      expect(openCalls).toHaveLength(2);
    });
  });

  describe('before a person opens (options and the guard)', () => {
    it('quotes the first currency, what else is on, and the fee', async () => {
      const gb = await world.options('GB');
      expect(gb).toMatchObject({
        country: 'GB',
        abroad: true,
        available: true,
        suggested: 'GBP',
        openFee: { currency: 'GBP', amountMinor: 0 },
      });
      expect(gb.choices.map((c) => [c.code, c.enabled])).toEqual([
        ['USD', true],
        ['EUR', true],
        ['GBP', true],
        ['CAD', true],
        ['AED', true],
        ['GHS', false],
      ]);
      expect((await world.options('NG')).unavailableReason).toBe('nigeria');
      expect((await world.options('KP')).unavailableReason).toBe(
        'country_blocked',
      );
    });

    it('settles the first currency: the pick, else the country’s own; refuses a held-back country or a switched-off currency', async () => {
      const id = randomUUID();
      expect(await world.guardOpen(id, 'GB', undefined)).toBe('GBP');
      expect(await world.guardOpen(id, 'GB', 'EUR')).toBe('EUR');
      await expect(world.guardOpen(id, 'KP', undefined)).rejects.toMatchObject({
        code: 'country_not_supported',
      });
      await expect(world.guardOpen(id, 'GH', 'GHS')).rejects.toMatchObject({
        code: 'fx_switched_off',
      });
    });
  });

  describe('the wallet gate', () => {
    it('an open world wallet reaches the foreign-account routes, and never the naira ones', async () => {
      const id = await person('US');
      await world.ensureFirstAccount(id);
      const open = await gate.requireOpenOrWorld(id);
      expect(open.wawuUserId).toBe(id);
      expect(open.walletId).toBe('');
      expect(open.customerId).toMatch(/^01ENT/);
      // A naira route does not send them to open a wallet they already have.
      await expect(gate.requireOpen(id)).rejects.toMatchObject({
        code: 'wallet_not_open',
        message: NO_NAIRA_ACCOUNT_MESSAGE,
      });
    });

    it('a world opening still in its review is not a wallet yet', async () => {
      const id = await person('US', { status: 'pending' });
      await expect(gate.requireOpenOrWorld(id)).rejects.toMatchObject({
        code: 'wallet_opening',
      });
    });

    it('a cancelled opening is not a wallet', async () => {
      const id = await person('US');
      await world.ensureFirstAccount(id);
      await prisma.fintavaWalletOpening.update({
        where: { wawuUserId: id },
        data: { worldCancelledAt: new Date(), state: 'stopped' },
      });
      await expect(gate.requireOpenOrWorld(id)).rejects.toBeInstanceOf(
        MoneyError,
      );
    });
  });

  describe('support: list, freeze, unfreeze, cancel', () => {
    it('lists by country and stage with no name, document or number', async () => {
      const a = await person('JP', { status: 'pending' });
      const b = await person('JP');
      await world.ensureFirstAccount(b);
      const page = await admin.list({ country: 'JP' });
      const rows = Object.fromEntries(page.items.map((i) => [i.wawuUserId, i]));
      expect(rows[a].stage).toBe('checking');
      expect(rows[b].stage).toBe('open');
      expect(rows[b].firstCurrency).toBe('USD');
      expect(JSON.stringify(page)).not.toMatch(/hash-|bvnHash|phone|idNumber/);
      const onlyOpen = await admin.list({ country: 'JP', stage: 'open' });
      expect(onlyOpen.items.map((i) => i.wawuUserId)).toEqual([b]);
    });

    it('a freeze stops the accounts and the first account, writes one audit row, and a repeat changes nothing', async () => {
      const id = await person('CA');
      await prisma.fxAccount.create({
        data: {
          wawuUserId: id,
          provider: 'nuvion',
          currency: 'CAD',
          chain: '',
          providerCustomerId: 'cust',
          providerAccountId: `acc-${id}`,
          status: 'open',
        },
      });
      const first = await admin.act(
        ADMIN,
        id,
        'freeze',
        'document looks altered',
      );
      expect(first).toMatchObject({
        changed: true,
        stageBefore: 'approved',
        stageAfter: 'frozen',
        accountsChanged: 1,
      });
      expect(await world.ensureFirstAccount(id)).toBe('blocked');
      const again = await admin.act(ADMIN, id, 'freeze', 'again');
      expect(again.changed).toBe(false);
      const audit = await prisma.worldAdminAudit.findMany({
        where: { subjectWawuId: id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'freeze',
        reason: 'document looks altered',
        actedByAdminId: ADMIN.id,
        actedByAdminRole: 'finance',
      });
      const acc = await prisma.fxAccount.findFirstOrThrow({
        where: { wawuUserId: id },
      });
      expect(acc.status).toBe('frozen');
      const back = await admin.act(ADMIN, id, 'unfreeze', 'checked, fine');
      expect(back).toMatchObject({ changed: true, accountsChanged: 1 });
      expect(
        (await prisma.fxAccount.findFirstOrThrow({ where: { wawuUserId: id } }))
          .status,
      ).toBe('open');
      expect(
        await prisma.worldAdminAudit.count({ where: { subjectWawuId: id } }),
      ).toBe(2);
    });

    it('parallel acts on one person write one audit row each act that changed something', async () => {
      const id = await person('CA');
      const six = await Promise.all(
        Array.from({ length: 6 }, () =>
          admin.act(ADMIN, id, 'freeze', 'parallel'),
        ),
      );
      expect(six.filter((r) => r.changed)).toHaveLength(1);
      expect(
        await prisma.worldAdminAudit.count({
          where: { subjectWawuId: id, action: 'freeze' },
        }),
      ).toBe(1);
    });

    it('an unfreeze lets go only of accounts the world freeze froze', async () => {
      const id = await person('CA');
      await prisma.fxAccount.create({
        data: {
          wawuUserId: id,
          provider: 'nuvion',
          currency: 'USD',
          chain: '',
          providerCustomerId: 'cust',
          providerAccountId: `acc-${id}`,
          status: 'frozen',
          frozenAt: new Date(),
          frozenReason: 'frozen on its own by an admin',
        },
      });
      await admin.act(ADMIN, id, 'freeze', 'review');
      await admin.act(ADMIN, id, 'unfreeze', 'done');
      expect(
        (await prisma.fxAccount.findFirstOrThrow({ where: { wawuUserId: id } }))
          .status,
      ).toBe('frozen');
    });

    it('a cancel stops an opening that is not open, lets go of its claim and blocks the first account', async () => {
      const id = await person('FR', { status: 'pending', currency: 'EUR' });
      const out = await admin.act(ADMIN, id, 'cancel', 'not who they say');
      expect(out).toMatchObject({ changed: true, stageAfter: 'cancelled' });
      const row = await prisma.fintavaWalletOpening.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.state).toBe('stopped');
      expect(row.failure).toBe('cancelled_by_admin');
      expect(row.bvnHash).toBe(releasedBvnHash(id, `hash-${id}`));
      expect((await admin.act(ADMIN, id, 'cancel', 'again')).changed).toBe(
        false,
      );
      expect(await world.ensureFirstAccount(id)).toBe('blocked');
      expect(
        await prisma.worldAdminAudit.count({ where: { subjectWawuId: id } }),
      ).toBe(1);
    });

    it('an open wallet is not cancelled, it is frozen; a person with no world opening is not found', async () => {
      const id = await person('FR');
      await world.ensureFirstAccount(id);
      await expect(admin.act(ADMIN, id, 'cancel', 'no')).rejects.toMatchObject({
        code: 'wallet_already_open',
      });
      await expect(
        admin.act(ADMIN, randomUUID(), 'freeze', 'no one'),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        await prisma.worldAdminAudit.count({ where: { subjectWawuId: id } }),
      ).toBe(0);
    });
  });

  describe('what GET /money/wallet tells', () => {
    const row = {
      worldCountry: 'DE',
      worldFirstCurrency: 'EUR',
      worldAccountOpenedAt: null,
      worldFrozenAt: null,
      worldCancelledAt: null,
    };
    it('says nothing for a Nigerian opening', () => {
      expect(worldViewOf(null)).toBeUndefined();
      expect(worldViewOf({ ...row, worldCountry: null })).toBeUndefined();
    });
    it('opening, open, frozen, cancelled', () => {
      const at = new Date('2026-11-18T10:00:00Z');
      expect(worldViewOf(row)).toEqual({
        country: 'DE',
        firstCurrency: 'EUR',
        state: 'opening',
        accountOpenedAt: null,
      });
      expect(worldViewOf({ ...row, worldAccountOpenedAt: at })?.state).toBe(
        'open',
      );
      expect(
        worldViewOf({ ...row, worldAccountOpenedAt: at, worldFrozenAt: at })
          ?.state,
      ).toBe('frozen');
      expect(worldViewOf({ ...row, worldCancelledAt: at })?.state).toBe(
        'cancelled',
      );
    });
    it('the stage support reads follows the review until the account is open', () => {
      const r = {
        wawuUserId: 'x',
        bvnHash: 'h',
        state: 'open',
        failure: null,
        worldCountry: 'DE',
        worldFirstCurrency: 'EUR',
        worldAccountOpenedAt: null,
        worldFrozenAt: null,
        worldFrozenReason: null,
        worldCancelledAt: null,
        createdAt: new Date(),
      };
      const e = (status: string) => ({
        status,
        decidedAt: null,
        correctedAt: null,
        bvnStatus: null,
        ninStatus: null,
        documentStatus: null,
        addressProofStatus: null,
        rejectionReasons: [],
      });
      expect(worldStageOf(r, null)).toBe('started');
      expect(worldStageOf(r, e('incomplete'))).toBe('needs_documents');
      expect(worldStageOf(r, e('pending'))).toBe('checking');
      expect(worldStageOf(r, e('approved'))).toBe('approved');
      expect(worldStageOf(r, e('rejected'))).toBe('rejected');
      expect(worldStageOf(r, e('suspended'))).toBe('stopped');
      expect(
        worldStageOf({ ...r, worldAccountOpenedAt: new Date() }, e('approved')),
      ).toBe('open');
    });
  });
});
