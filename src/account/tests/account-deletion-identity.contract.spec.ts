/* eslint-disable */
/**
 * SETTINGS-08 (G-SETTINGS-08-1), the Hub half. WAWU ID cancels a deletion when
 * the person signs in during the 30 days, but only if the Hub's mark-deletion
 * call reached it. So the call carries the Hub's `purgeAfter`, is asked again
 * until WAWU ID confirms, and the Hub never purges an account WAWU ID has not
 * confirmed. Wallet provider: the Nuvion-shaped double (balance only); no
 * Fintava anywhere.
 */
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { AccountModule } from '../account.module';
import {
  identityRetryDelayMs,
  IDENTITY_RETRY_BASE_MS,
  IDENTITY_RETRY_MAX_MS,
} from '../account-deletion-config';
import { AccountDeletionIdentityService } from '../account-deletion-identity.service';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import { WAWU_ID_ACCOUNT_GATEWAY } from '../wawu-id-account.gateway';

describe('SETTINGS-08: WAWU ID is told the deletion started, until it confirms', () => {
  jest.setTimeout(60000);
  const provider: any = {
    name: 'nuvion',
    label: 'Nuvion',
    timings: { retryAfterSeconds: 3 },
    getBalance: jest.fn(async () => ({ availableKobo: 0n, bookedKobo: 0n })),
  };
  const state = { idDown: false };
  const gateway = {
    scheduleAccountDeletion: jest.fn(),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const people: string[] = [];
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;
  let sweep: AccountDeletionSweepService;
  let identity: AccountDeletionIdentityService;

  const person = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };
  const row = (id: string) =>
    prisma.accountDeletion.findUniqueOrThrow({ where: { wawuUserId: id } });
  const markCalls = (id: string) =>
    gateway.scheduleAccountDeletion.mock.calls.filter((c: any[]) => c[0] === id);
  /** The wait is over: the next pass may ask. */
  const waitOver = (id: string) =>
    prisma.accountDeletion.update({
      where: { wawuUserId: id },
      data: { identityMarkNextAt: new Date(Date.now() - 1000) },
    });
  /** A moment after the 30 days (the pass takes its clock, so the row's date is left as it is). */
  const afterTheWait = () => new Date(Date.now() + 31 * 86400000);

  /**
   * FIX-92. A pass takes every due row in the table, and a clock 31 days ahead
   * makes every scheduled row due, not only this spec's people. The deploy runs
   * every spec in one process on one database, so a row another spec (or the
   * seed) left behind, the seeded plain user's above all, would be purged here
   * and every spec after this one would read an account that is gone. So the
   * rows that exist before this spec starts are held for its length with the
   * sweep's own marks: `reconcileClaimedUntil` in the future (no pass takes a
   * held row) and `identityMarkNextAt` further out than any clock below (no
   * pass asks WAWU ID about it). Raw SQL, so `updatedAt` is not touched. They
   * are put back as they were in afterAll.
   */
  let others: { wawuUserId: string; claim: Date | null; markNext: Date | null }[] = [];

  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .overrideProvider(WALLET_PROVIDER)
      .useValue(provider)
      .compile();
    app = m.createNestApplication();
    await app.init();
    prisma = m.get(PrismaService);
    accounts = m.get(AccountService);
    sweep = m.get(AccountDeletionSweepService);
    identity = m.get(AccountDeletionIdentityService);
    others = await prisma.$queryRaw<typeof others>`
      SELECT "wawuUserId", "reconcileClaimedUntil" AS "claim", "identityMarkNextAt" AS "markNext"
      FROM "AccountDeletion"`;
    await prisma.$executeRaw`
      UPDATE "AccountDeletion"
      SET "reconcileClaimedUntil" = ${new Date(Date.now() + 86400000)},
          "identityMarkNextAt" = ${new Date(Date.now() + 90 * 86400000)}
      WHERE "wawuUserId" = ANY(${others.map((o) => o.wawuUserId)})`;
  });

  afterAll(async () => {
    for (const o of others) {
      await prisma.$executeRaw`
        UPDATE "AccountDeletion"
        SET "reconcileClaimedUntil" = ${o.claim}, "identityMarkNextAt" = ${o.markNext}
        WHERE "wawuUserId" = ${o.wawuUserId}`;
    }
    await prisma.accountDeletionContent.deleteMany({ where: { wawuUserId: { in: people } } });
    await prisma.accountDeletion.deleteMany({ where: { wawuUserId: { in: people } } });
    await prisma.pushStoppedAccount.deleteMany({ where: { userWawuId: { in: people } } });
    await app.close();
  });

  beforeEach(() => {
    state.idDown = false;
    gateway.scheduleAccountDeletion.mockReset().mockImplementation(async () => {
      if (state.idDown) throw new Error('id down');
      return { scheduled: true };
    });
    gateway.finalizeAccountDeletion.mockClear();
  });

  it('I1 the call carries the Hub purgeAfter, equal to the date answered and the date stored, and the answer is recorded', async () => {
    const id = person();
    const r = await accounts.deleteAccount(id);
    const stored = await row(id);
    expect(markCalls(id)).toHaveLength(1);
    const [, sent] = markCalls(id)[0];
    expect(sent).toBeInstanceOf(Date);
    expect(sent.toISOString()).toBe(r.deletionScheduledAt);
    expect(sent.getTime()).toBe(stored.purgeAfter.getTime());
    expect(stored.purgeAfter.getTime() - stored.scheduledAt.getTime()).toBe(30 * 86400000);
    expect(stored).toMatchObject({
      status: 'scheduled',
      identityMarkAttempts: 0,
      identityMarkNextAt: null,
    });
    expect(stored.identityMarkedAt).not.toBeNull();
  });

  it('I2 WAWU ID failing then recovering: the request still answers, the call is retried with a growing wait until it confirms, with the same purgeAfter', async () => {
    const id = person();
    state.idDown = true;
    const r = await accounts.deleteAccount(id);
    expect(r).toHaveProperty('deletionScheduledAt');
    let stored = await row(id);
    expect(stored.status).toBe('scheduled');
    expect(stored.identityMarkedAt).toBeNull();
    expect(stored.identityMarkAttempts).toBe(1);
    const firstWait = stored.identityMarkNextAt!.getTime() - Date.now();
    expect(firstWait).toBeGreaterThan(IDENTITY_RETRY_BASE_MS - 30_000);
    expect(firstWait).toBeLessThanOrEqual(IDENTITY_RETRY_BASE_MS);

    // Inside the wait nothing is asked.
    await identity.retryDue(new Date());
    await sweep.runOnce(new Date(), 100);
    expect(markCalls(id)).toHaveLength(1);

    // The wait is over and WAWU ID is still down: asked again, waits longer.
    await waitOver(id);
    await identity.retryDue(new Date());
    expect(markCalls(id)).toHaveLength(2);
    stored = await row(id);
    expect(stored.identityMarkedAt).toBeNull();
    expect(stored.identityMarkAttempts).toBe(2);
    const secondWait = stored.identityMarkNextAt!.getTime() - Date.now();
    expect(secondWait).toBeGreaterThan(firstWait + 60_000);

    // It recovers: the next pass confirms, and the call never changed its date.
    state.idDown = false;
    await waitOver(id);
    const result = await sweep.runOnce(new Date(), 100);
    expect(result.identityConfirmed).toBeGreaterThanOrEqual(1);
    expect(markCalls(id)).toHaveLength(3);
    for (const c of markCalls(id)) expect(c[1].toISOString()).toBe(r.deletionScheduledAt);
    stored = await row(id);
    expect(stored.identityMarkedAt).not.toBeNull();
    expect(stored.identityMarkAttempts).toBe(0);
    expect(stored.identityMarkNextAt).toBeNull();

    // Confirmed: it is not asked again.
    await sweep.runOnce(new Date(), 100);
    expect(markCalls(id)).toHaveLength(3);
  });

  it('I3 the wait doubles from the base and stops growing at the cap', () => {
    expect(identityRetryDelayMs(1)).toBe(IDENTITY_RETRY_BASE_MS);
    expect(identityRetryDelayMs(2)).toBe(2 * IDENTITY_RETRY_BASE_MS);
    expect(identityRetryDelayMs(3)).toBe(4 * IDENTITY_RETRY_BASE_MS);
    expect(identityRetryDelayMs(500)).toBe(IDENTITY_RETRY_MAX_MS);
  });

  it('I4 the purge waits for WAWU ID: a due row it has not confirmed is not purged, is reported, and is purged the pass after it confirms', async () => {
    const id = person();
    state.idDown = true;
    await accounts.deleteAccount(id);
    const sent = (await row(id)).purgeAfter;
    await waitOver(id);

    const first = await sweep.runOnce(afterTheWait(), 100);
    expect(first.identityUnconfirmed).toBeGreaterThanOrEqual(1);
    let stored = await row(id);
    expect(stored.status).toBe('scheduled');
    expect(stored.purgeBlockedBy).toBe('identity_unconfirmed');
    expect(stored.purgeAttempts).toBeGreaterThanOrEqual(1);
    expect(stored.purgedAt).toBeNull();
    expect(gateway.finalizeAccountDeletion.mock.calls.filter((c: any[]) => c[0] === id)).toHaveLength(0);

    // Still down on the next pass (after its wait): still nothing purged.
    await waitOver(id);
    const second = await sweep.runOnce(afterTheWait(), 100);
    expect(second.identityUnconfirmed).toBeGreaterThanOrEqual(1);
    expect((await row(id)).status).toBe('scheduled');
    expect(gateway.finalizeAccountDeletion.mock.calls.filter((c: any[]) => c[0] === id)).toHaveLength(0);

    // WAWU ID answers: confirmed and purged in the same pass, asked with the stored date.
    state.idDown = false;
    await waitOver(id);
    const third = await sweep.runOnce(afterTheWait(), 100);
    expect(third.purged).toBeGreaterThanOrEqual(1);
    stored = await row(id);
    expect(stored.status).toBe('purged');
    expect(stored.identityMarkedAt).not.toBeNull();
    expect(stored.purgeBlockedBy).toBeNull();
    for (const c of markCalls(id)) expect(c[1].getTime()).toBe(sent.getTime());
    expect(gateway.finalizeAccountDeletion.mock.calls.filter((c: any[]) => c[0] === id)).toHaveLength(1);
  });

  it('I5 a row the claim finds unconfirmed cannot become purging, whatever read it first', async () => {
    const id = person();
    state.idDown = true;
    await accounts.deleteAccount(id);
    const claimed = await prisma.accountDeletion.updateMany({
      where: {
        wawuUserId: id,
        status: 'scheduled',
        purgeAfter: { lte: afterTheWait() },
        identityMarkedAt: { not: null },
      },
      data: { status: 'purging' },
    });
    expect(claimed.count).toBe(0);
    expect((await row(id)).status).toBe('scheduled');
  });

  it('I6 a new deletion after a cancel has to be confirmed on its own, and an answer to the old call does not confirm it', async () => {
    const id = person();
    await accounts.deleteAccount(id);
    const old = await row(id);
    expect(old.identityMarkedAt).not.toBeNull();
    expect((await accounts.cancelDeletion(id)).cancelled).toBe(true);

    state.idDown = true;
    await accounts.deleteAccount(id);
    const fresh = await row(id);
    expect(fresh.status).toBe('scheduled');
    expect(fresh.purgeAfter.getTime()).not.toBe(old.purgeAfter.getTime());
    expect(fresh.identityMarkedAt).toBeNull();
    expect(fresh.identityMarkAttempts).toBe(1);

    // A late answer to the first deletion's call names the first date.
    state.idDown = false;
    expect(await identity.tell(id, old.purgeAfter)).toBe(true);
    expect((await row(id)).identityMarkedAt).toBeNull();

    // The second deletion's own call confirms it.
    expect(await identity.tell(id, fresh.purgeAfter)).toBe(true);
    expect((await row(id)).identityMarkedAt).not.toBeNull();
  });

  it('I7 a repeat request asks again at once, even inside the wait, and confirms when WAWU ID answers', async () => {
    const id = person();
    state.idDown = true;
    await accounts.deleteAccount(id);
    expect((await row(id)).identityMarkedAt).toBeNull();
    state.idDown = false;
    await accounts.deleteAccount(id);
    expect(markCalls(id)).toHaveLength(2);
    expect((await row(id)).identityMarkedAt).not.toBeNull();
  });

  it('I8 a pass stops asking after three failures in a row (WAWU ID is down) and the rows it did not reach are not held', async () => {
    const ids = [person(), person(), person(), person()];
    for (const [i, id] of ids.entries()) {
      await prisma.accountDeletion.create({
        data: {
          wawuUserId: id,
          status: 'scheduled',
          scheduledAt: new Date(Date.UTC(2001, 0, 1 + i)),
          purgeAfter: new Date(Date.UTC(2001, 0, 31 + i)),
        },
      });
    }
    state.idDown = true;
    const r = await identity.retryDue(new Date(), 4, 3);
    expect(r).toMatchObject({ asked: 3, failed: 3, confirmed: 0, outage: true });
    const asked = ids.filter((id) => markCalls(id).length > 0);
    expect(asked).toHaveLength(3);
    const left = ids.find((id) => markCalls(id).length === 0)!;
    expect((await row(left)).identityMarkNextAt).toBeNull();
    for (const id of asked) {
      const s = await row(id);
      expect(s.identityMarkAttempts).toBe(1);
      expect(s.identityMarkNextAt!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('I9 two passes at once ask WAWU ID about a row once', async () => {
    const id = person();
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: id,
        status: 'scheduled',
        scheduledAt: new Date(Date.UTC(2000, 5, 1)),
        purgeAfter: new Date(Date.UTC(2000, 5, 30)),
      },
    });
    const [a, b] = await Promise.all([
      identity.retryDue(new Date(), 1, 3),
      identity.retryDue(new Date(), 1, 3),
    ]);
    expect(markCalls(id).length).toBe(1);
    expect(a.confirmed + b.confirmed).toBe(1);
    expect((await row(id)).identityMarkedAt).not.toBeNull();
  });
});
