import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  Money14App,
  type Person,
} from '../../../../test/money/pin-approval-harness';
import type { PinResetView, PinStateView } from '../../money-view.type';
import {
  canonicalJson,
  PIN_CHANGE_ROUTE,
  PIN_KEY_KEEP_HOURS,
  PIN_RESET_CONFIRM_ROUTE,
  PinRequestKeys,
  STALE_CLAIM_SECONDS,
} from '../pin-request-keys.service';
import { TransactionPinService } from '../transaction-pin.service';

/**
 * The optional Idempotency-Key on the two routes that replace a PIN (task
 * WALLET-06 round 2, D1), over HTTP: real database, real tokens, the real
 * Fintava client over a socket to a stand-in. Each test is a new person.
 *
 * The rule under test: a phone that got no answer sends the same request
 * again with the same key and never has to guess. If the first landed it
 * gets the first answer back and no PIN try is used; if the PIN was changed
 * by someone else meanwhile it is refused as any wrong PIN is, and says so;
 * and without a key nothing is stored and nothing changes.
 */

jest.setTimeout(120_000);

const PIN = '/api/hub/money/pin';
const CONFIRM = '/api/hub/money/pin/reset/confirm';

const t = new Money14App({});
const pins = t.reservePins(300);
const secrets = new Set<string>();
function pin(): string {
  const next = pins.shift();
  if (!next) throw new Error('the PIN pool is used up: reserve more');
  secrets.add(next);
  return next;
}

beforeAll(() => t.start());
afterAll(() => t.stop());
beforeEach(() => t.installDefaults());

const newKey = () => randomUUID();

async function holder(first: string = pin()): Promise<Person> {
  const who = t.person();
  await t.bvnChecked(who);
  await t.openWallet(who);
  await t.setPin(who, first);
  return who;
}

/** PUT /money/pin, with the current PIN in its header and a key when one is given. */
function change(
  who: Person,
  current: string | null,
  next: string,
  key: string | null,
  confirmation: string = next,
) {
  secrets.add(next);
  let req = t.http().put(PIN).set('Authorization', who.auth);
  if (current !== null) req = req.set('X-Transaction-Pin', current);
  if (key !== null) req = req.set('Idempotency-Key', key);
  return req.send({ newPin: next, newPinConfirmation: confirmation });
}

async function resetOf(
  who: Person,
): Promise<{ resetId: string; code: string }> {
  const res = await t
    .http()
    .post('/api/hub/money/pin/reset')
    .set('Authorization', who.auth)
    .expect(201);
  const view = t.body<PinResetView>(res).data!;
  const code = t.lastCode(who.phone);
  secrets.add(code);
  return { resetId: view.resetId, code };
}

function confirm(
  who: Person,
  body: { resetId: string; code: string; newPin: string },
  key: string | null,
) {
  secrets.add(body.newPin);
  let req = t.http().post(CONFIRM).set('Authorization', who.auth);
  if (key !== null) req = req.set('Idempotency-Key', key);
  return req.send({ ...body, newPinConfirmation: body.newPin });
}

const rowsFor = (who: Person) =>
  t.prisma.moneyPinRequestKey.findMany({ where: { wawuUserId: who.id } });

const pinRow = (who: Person) =>
  t.prisma.transactionPin.findUniqueOrThrow({
    where: { wawuUserId: who.id },
  });

describe('PUT /money/pin with an Idempotency-Key', () => {
  it('without a key nothing is stored and the route answers as it always has', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const res = await change(who, first, next, null).expect(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(t.body<PinStateView>(res).data).toMatchObject({ isSet: true });
    expect(await rowsFor(who)).toEqual([]);
    await t.approveWithPin(who, next).expect(200);
  });

  it('a repeat after the change landed answers the first answer, byte for byte, and the PIN is not looked at: no try is used', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();

    const firstRes = await change(who, first, next, key).expect(200);
    expect(firstRes.headers['idempotent-replayed']).toBeUndefined();
    const changedAt = t.body<PinStateView>(firstRes).data!.changedAt;
    const afterFirst = await pinRow(who);

    // The same request again with the PIN it was first sent under, which is
    // no longer the PIN: answered from the store, before the PIN guard.
    const again = await change(who, first, next, key).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.text).toBe(firstRes.text);
    expect(t.body<PinStateView>(again).data!.changedAt).toBe(changedAt);

    // No PIN at all, a wrong one, a malformed one: still the first answer.
    for (const current of [null, pin(), 'abcd']) {
      const r = await change(who, current, next, key).expect(200);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(r.text).toBe(firstRes.text);
    }

    // Nothing moved and nothing was counted.
    const after = await pinRow(who);
    expect(after.failedTries).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(after.pinHash).toBe(afterFirst.pinHash);
    expect(after.setAt.toISOString()).toBe(afterFirst.setAt.toISOString());
    await t.approveWithPin(who, next).expect(200);
    await t.approveWithPin(who, first).expect(403);
    const rows = await rowsFor(who);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: PIN_CHANGE_ROUTE,
      key,
      state: 'done',
      responseStatus: 200,
    });
  });

  it('the stored answer is the PIN state and nothing else: no PIN, and the body only as an argon2id hash', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    const [row] = await rowsFor(who);
    expect(row.fingerprint).toMatch(/^\$argon2id\$/);
    expect(row.fingerprint).not.toContain(next);
    const stored = JSON.parse(row.responseBody!) as object;
    expect(stored).toMatchObject({
      statusCode: 200,
      message: 'OK',
      data: { isSet: true, triesLeft: 5 },
    });
    expect(Object.keys(stored).sort()).toEqual([
      'data',
      'message',
      'statusCode',
    ]);
    for (const secret of [first, next]) {
      expect(row.responseBody).not.toContain(`"${secret}"`);
      expect(JSON.stringify(row)).not.toMatch(
        new RegExp(`(^|\\D)${secret}(\\D|$)`),
      );
    }
    expect(
      await argon2.verify(
        row.fingerprint,
        canonicalJson({ newPin: next, newPinConfirmation: next }),
      ),
    ).toBe(true);
  });

  it('the same key with another body is idempotency_key_reused and changes nothing', async () => {
    const first = pin();
    const next = pin();
    const other = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    const refused = await change(who, first, other, key).expect(409);
    expect(t.body(refused).reason).toMatchObject({
      code: 'idempotency_key_reused',
    });
    await t.approveWithPin(who, next).expect(200);
    await t.approveWithPin(who, other).expect(403);
  });

  it('a key belongs to one person and one route', async () => {
    const aFirst = pin();
    const bFirst = pin();
    const a = await holder(aFirst);
    const b = await holder(bFirst);
    const key = newKey();
    const aNext = pin();
    const bNext = pin();
    await change(a, aFirst, aNext, key).expect(200);
    // Another person sending the same text: their own request, not a replay.
    const res = await change(b, bFirst, bNext, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    await t.approveWithPin(b, bNext).expect(200);
    // The same text on the other route is not this route's key either.
    const reset = await resetOf(a);
    const viaReset = await confirm(
      a,
      { resetId: reset.resetId, code: reset.code, newPin: pin() },
      key,
    ).expect(200);
    expect(viaReset.headers['idempotent-replayed']).toBeUndefined();
    expect((await rowsFor(a)).map((r) => r.route).sort()).toEqual(
      [PIN_CHANGE_ROUTE, PIN_RESET_CONFIRM_ROUTE].sort(),
    );
  });

  it('a refusal gives the key back: the wrong PIN (a try is used), a mismatch, a bad body; then the same key goes through', async () => {
    const first = pin();
    const wrong = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();

    const wrongPin = await change(who, wrong, next, key).expect(403);
    expect(t.body(wrongPin).reason).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });
    expect(await rowsFor(who)).toEqual([]);

    const mismatch = await change(who, first, next, key, pin()).expect(400);
    expect(t.body(mismatch).reason).toMatchObject({ code: 'pin_mismatch' });
    expect(await rowsFor(who)).toEqual([]);

    await t
      .http()
      .put(PIN)
      .set('Authorization', who.auth)
      .set('X-Transaction-Pin', first)
      .set('Idempotency-Key', key)
      .send({ newPin: 'abcd', newPinConfirmation: 'abcd' })
      .expect(400);
    expect(await rowsFor(who)).toEqual([]);

    const ok = await change(who, first, next, key).expect(200);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
    expect(await rowsFor(who)).toHaveLength(1);
    await t.approveWithPin(who, next).expect(200);
  });

  it('a wallet that is not open, and a person with no PIN, take no key and use no try', async () => {
    const stranger = t.person();
    await change(stranger, '1234', pin(), newKey()).expect(409);
    expect(await rowsFor(stranger)).toEqual([]);
    const walletOnly = t.person();
    await t.bvnChecked(walletOnly);
    await t.openWallet(walletOnly);
    const res = await change(walletOnly, '1234', pin(), newKey()).expect(409);
    expect(t.body(res).reason).toMatchObject({ code: 'pin_not_set' });
    expect(await rowsFor(walletOnly)).toEqual([]);
  });

  it('a key that is sent but unusable is refused, not ignored, and costs no try', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    for (const key of ['', 'short', 'has space in it', `${'a'.repeat(129)}`]) {
      // A wrong PIN rides along: the key is refused first, so no try is used.
      const res = await change(who, pin(), next, key).expect(400);
      expect(t.body(res).reason).toMatchObject({
        code: 'idempotency_key_required',
      });
    }
    expect(await rowsFor(who)).toEqual([]);
    expect((await pinRow(who)).failedTries).toBe(0);
  });

  it('a repeat while the first is still running waits (409 idempotency_in_progress) and uses no try; another body is key_reused', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    // The first request has taken the key and has not finished.
    await t.prisma.moneyPinRequestKey.create({
      data: {
        wawuUserId: who.id,
        route: PIN_CHANGE_ROUTE,
        key,
        fingerprint: await argon2.hash(
          canonicalJson({ newPin: next, newPinConfirmation: next }),
          { type: argon2.argon2id },
        ),
        claimId: randomUUID(),
      },
    });
    const waiting = await change(who, pin(), next, key).expect(409);
    expect(t.body(waiting).reason).toMatchObject({
      code: 'idempotency_in_progress',
      retryAfterSeconds: 2,
    });
    const reused = await change(who, first, pin(), key).expect(409);
    expect(t.body(reused).reason).toMatchObject({
      code: 'idempotency_key_reused',
    });
    expect((await pinRow(who)).failedTries).toBe(0);
    await t.approveWithPin(who, first).expect(200);
  });

  it('a claim older than a minute is a request that died before it changed anything: the key is taken again', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    const dead = await t.prisma.moneyPinRequestKey.create({
      data: {
        wawuUserId: who.id,
        route: PIN_CHANGE_ROUTE,
        key,
        fingerprint: await argon2.hash('{"x":1}', { type: argon2.argon2id }),
        claimId: randomUUID(),
      },
    });
    await t.prisma
      .$executeRaw`UPDATE "MoneyPinRequestKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "claimId" = ${dead.claimId}`;
    const res = await change(who, first, next, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const [row] = await rowsFor(who);
    expect(row.state).toBe('done');
    expect(row.claimId).not.toBe(dead.claimId);
  });

  it('the same request many times at once changes the PIN once: one answer is new, the rest are replays or told to wait, and no try is used', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    const all = await Promise.all(
      Array.from({ length: 8 }, () => change(who, first, next, key)),
    );
    const statuses = all.map((r) => r.status);
    for (const s of statuses) expect([200, 409]).toContain(s);
    const fresh = all.filter(
      (r) => r.status === 200 && r.headers['idempotent-replayed'] === undefined,
    );
    expect(fresh).toHaveLength(1);
    for (const r of all.filter((x) => x.status === 409)) {
      expect(t.body(r).reason).toMatchObject({
        code: 'idempotency_in_progress',
      });
    }
    for (const r of all.filter((x) => x.status === 200)) {
      expect(r.text).toBe(fresh[0].text);
    }
    expect((await pinRow(who)).failedTries).toBe(0);
    await t.approveWithPin(who, next).expect(200);
    // After the dust settles the repeat is a plain replay.
    const later = await change(who, first, next, key).expect(200);
    expect(later.headers['idempotent-replayed']).toBe('true');
    expect(later.text).toBe(fresh[0].text);
  });

  it('the answer is stored in the same transaction as the change: a request that lost its claim changes nothing', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const before = await pinRow(who);
    const service = t.app.get(TransactionPinService);
    await expect(
      service.change(
        who.id,
        { newPin: next, newPinConfirmation: next },
        {
          wawuUserId: who.id,
          route: PIN_CHANGE_ROUTE,
          key: newKey(),
          claimId: randomUUID(),
        },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_in_progress' });
    const after = await pinRow(who);
    expect(after.pinHash).toBe(before.pinHash);
    expect(after.setAt.toISOString()).toBe(before.setAt.toISOString());
    await t.approveWithPin(who, first).expect(200);
  });
});

describe('the case a lost answer used to get wrong (verifier D1)', () => {
  it('the change landed and its answer was lost: the same request again answers the first outcome and the new PIN is the PIN', async () => {
    const first = pin();
    const mine = pin();
    const who = await holder(first);
    const key = newKey();
    // Request 1 reaches the server; its answer never reaches the phone.
    const lost = await change(who, first, mine, key).expect(200);
    // The phone sends it again.
    const again = await change(who, first, mine, key).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.text).toBe(lost.text);
    await t.approveWithPin(who, mine).expect(200);
  });

  it('the request never reached the server and someone else changed the PIN: the same request again is refused for the PIN, not reported as done', async () => {
    const first = pin();
    const mine = pin();
    const theirs = pin();
    const who = await holder(first);
    const key = newKey();
    // Another phone changes the PIN (no key), while request 1 is lost.
    await change(who, first, theirs, null).expect(200);
    // Request 1 again: its PIN in use is no longer the PIN.
    const refused = await change(who, first, mine, key).expect(403);
    expect(t.body(refused).reason).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });
    expect(refused.headers['idempotent-replayed']).toBeUndefined();
    // The PIN is theirs, mine is not a PIN, and the key was given back.
    await t.approveWithPin(who, theirs).expect(200);
    await t.approveWithPin(who, mine).expect(403);
    expect(await rowsFor(who)).toEqual([]);
  });

  it('the request never reached the server: the same request again is the request, and runs', async () => {
    const first = pin();
    const mine = pin();
    const who = await holder(first);
    const res = await change(who, first, mine, newKey()).expect(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    await t.approveWithPin(who, mine).expect(200);
  });
});

describe('POST /money/pin/reset/confirm with an Idempotency-Key', () => {
  it('without a key a repeat of a reset that landed is refused as a dead code (as it always was); with one it answers the first outcome', async () => {
    const first = pin();
    const chosen = pin();
    const who = await holder(first);
    const plain = await resetOf(who);
    await confirm(who, { ...plain, newPin: chosen }, null).expect(200);
    const dead = await confirm(who, { ...plain, newPin: chosen }, null).expect(
      400,
    );
    expect(t.body(dead).reason).toMatchObject({ code: 'reset_code_invalid' });
    expect(await rowsFor(who)).toEqual([]);

    const next = pin();
    const reset = await resetOf(who);
    const key = newKey();
    const landed = await confirm(who, { ...reset, newPin: next }, key).expect(
      200,
    );
    expect(landed.headers['idempotent-replayed']).toBeUndefined();
    const tries = (
      await t.prisma.transactionPinReset.findUniqueOrThrow({
        where: { id: reset.resetId },
      })
    ).failedTries;

    const again = await confirm(who, { ...reset, newPin: next }, key).expect(
      200,
    );
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.text).toBe(landed.text);
    // The code was not tried again, and the PIN is the one chosen.
    expect(
      (
        await t.prisma.transactionPinReset.findUniqueOrThrow({
          where: { id: reset.resetId },
        })
      ).failedTries,
    ).toBe(tries);
    await t.approveWithPin(who, next).expect(200);
    const [row] = await rowsFor(who);
    expect(row).toMatchObject({
      route: PIN_RESET_CONFIRM_ROUTE,
      state: 'done',
      responseStatus: 200,
    });
    expect(JSON.stringify(row)).not.toContain(reset.code);
    expect(row.fingerprint).toMatch(/^\$argon2id\$/);
  });

  it('a wrong code gives the key back; the right code under the same key then goes through', async () => {
    const first = pin();
    const chosen = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const key = newKey();
    const wrong = reset.code === '000000' ? '000001' : '000000';
    const refused = await confirm(
      who,
      { resetId: reset.resetId, code: wrong, newPin: chosen },
      key,
    ).expect(400);
    expect(t.body(refused).reason).toMatchObject({
      code: 'reset_code_invalid',
      triesLeft: 4,
    });
    expect(await rowsFor(who)).toEqual([]);
    const ok = await confirm(who, { ...reset, newPin: chosen }, key).expect(
      200,
    );
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
    await t.approveWithPin(who, chosen).expect(200);
  });

  it('the PIN was changed elsewhere after the code was sent: the same request again says the code is dead, it is not reported as done', async () => {
    const first = pin();
    const elsewhere = pin();
    const mine = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const key = newKey();
    await change(who, first, elsewhere, null).expect(200);
    const refused = await confirm(who, { ...reset, newPin: mine }, key).expect(
      400,
    );
    expect(t.body(refused).reason).toMatchObject({
      code: 'reset_code_invalid',
    });
    await t.approveWithPin(who, elsewhere).expect(200);
    await t.approveWithPin(who, mine).expect(403);
  });

  it('the same key with another new PIN is key_reused and changes nothing', async () => {
    const first = pin();
    const chosen = pin();
    const other = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const key = newKey();
    await confirm(who, { ...reset, newPin: chosen }, key).expect(200);
    const refused = await confirm(who, { ...reset, newPin: other }, key).expect(
      409,
    );
    expect(t.body(refused).reason).toMatchObject({
      code: 'idempotency_key_reused',
    });
    await t.approveWithPin(who, chosen).expect(200);
  });
});

describe('the keys are kept for a while and then go', () => {
  it('purge removes rows older than PIN_KEY_KEEP_HOURS and keeps the rest', async () => {
    const first = pin();
    const who = await holder(first);
    const keys = t.app.get(PinRequestKeys);
    const mk = async (hoursAgo: number) => {
      const key = newKey();
      await t.prisma.moneyPinRequestKey.create({
        data: {
          wawuUserId: who.id,
          route: PIN_CHANGE_ROUTE,
          key,
          fingerprint: 'x',
          state: 'done',
          claimId: randomUUID(),
          responseStatus: 200,
          responseBody: '{}',
        },
      });
      await t.prisma
        .$executeRaw`UPDATE "MoneyPinRequestKey" SET "updatedAt" = now() - ${`${hoursAgo} hours`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
      return key;
    };
    const old = await mk(PIN_KEY_KEEP_HOURS + 1);
    const fresh = await mk(PIN_KEY_KEEP_HOURS - 1);
    expect(PIN_KEY_KEEP_HOURS).toBeGreaterThanOrEqual(24);
    expect(await keys.purge()).toBeGreaterThanOrEqual(1);
    const left = (await rowsFor(who)).map((r) => r.key);
    expect(left).toContain(fresh);
    expect(left).not.toContain(old);
  });
});

describe('nothing secret is kept or logged', () => {
  it('no PIN and no code this file sent is in a log line, an answer, or a stored key row but as a hash', async () => {
    expect(secrets.size).toBeGreaterThan(20);
    const logs = t.log.lines.join('\n');
    const answers = t.answered.join('\n');
    const rows = JSON.stringify(
      await t.prisma.moneyPinRequestKey.findMany({
        where: { wawuUserId: { in: t.users } },
        select: {
          wawuUserId: true,
          route: true,
          key: true,
          state: true,
          responseStatus: true,
          responseBody: true,
        },
      }),
    );
    const plain = (text: string) =>
      text
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          'ID',
        )
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIME')
        .replace(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}/g, 'TIME')
        .replace(/\b\d+ ?ms\b/g, 'DURATION')
        .replace(/(127\.0\.0\.1|localhost):\d+/g, 'HOST')
        .replace(/\[Nest\] \d+/g, '[Nest] PID');
    const leaks = [...secrets].filter(
      (s) =>
        new RegExp(`(^|\\D)${s}(\\D|$)`).test(plain(logs)) ||
        new RegExp(`(^|\\D)${s}(\\D|$)`).test(plain(answers)) ||
        new RegExp(`(^|\\D)${s}(\\D|$)`).test(plain(rows)),
    );
    expect(leaks).toEqual([]);
  });
});
