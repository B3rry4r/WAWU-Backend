import { createHmac, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  Money14App,
  type Person,
} from '../../../../test/money/pin-approval-harness';
import type { PinResetView, PinStateView } from '../../money-view.type';
import {
  bodyFingerprint,
  IdempotencyService,
} from '../../payments/idempotency';
import { PaymentSettings } from '../../payments/payment-config';
import {
  CHANGED_AGAIN_MESSAGE,
  FINGERPRINT_LABEL,
  FINGERPRINT_PREFIX,
  FINGERPRINT_SECRET_KEY,
  PIN_CHANGE_ROUTE,
  PIN_KEY_WORDS,
  PIN_RESET_CONFIRM_ROUTE,
  PinRequestFingerprints,
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
  t.prisma.moneyIdempotencyKey.findMany({ where: { wawuUserId: who.id } });

const fingerprints = () => t.app.get(PinRequestFingerprints);

/** The fingerprint the store keeps for a request: what a row made by hand must carry to be this request's. */
const fingerprintOf = (
  who: Person,
  method: string,
  route: string,
  key: string,
  body: unknown,
) => fingerprints().of({ wawuUserId: who.id, method, route, key }, body);

/**
 * A reserved PIN that is not, by chance, a run of its own four digits inside
 * the fingerprint its PUT will be stored under (FIX-45). The fingerprint is
 * 64 random hex characters, so a given four-digit PIN sits inside one about 1
 * time in 1,070 (61 places, each 1 in 65,536), and "the PIN is not in the
 * fingerprint" failed on that chance alone (TIER-06's CI, "Expected substring:
 * not 7497" against "...ca7497698582"). The fingerprint is a pure function of
 * the person, the route, the key and the body, so it is worked out before the
 * request is sent and a PIN that would land in it is not used. The assertion
 * itself is unchanged and now holds every time; a Hub that put the PIN itself
 * into the fingerprint makes every candidate fail, and this throws.
 */
function pinOutsideFingerprint(who: Person, key: string): string {
  for (let tried = 1; tried <= 12; tried += 1) {
    const candidate = pin();
    const stored = fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, key, {
      newPin: candidate,
      newPinConfirmation: candidate,
    });
    if (!stored.includes(candidate)) return candidate;
  }
  throw new Error(
    'twelve PINs in a row were found inside their own fingerprint: the fingerprint carries the PIN',
  );
}

const UUID_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A stored key row as text for a leak scan, with the random tokens in it set
 * aside: its ids (random UUIDs) and its keyed fingerprint (a random 64-digit
 * hex digest, whose own scan for the PIN is `pinOutsideFingerprint`). A PIN is
 * four digits and a code six, and any random token holds such a run by chance
 * (a PIN as one UUID group or part of a digest: about 1 scan in 1,000, FIX-45),
 * which is no leak. Everything else in the row, the answer included, stays.
 */
const scannable = (row: object) =>
  JSON.stringify(row)
    .replace(UUID_TEXT, 'ID')
    .replace(/hmac-sha256:v1:[0-9a-f]{64}/g, 'FINGERPRINT');

/** The form written before round 3 (argon2id): what a row made by an older Hub carries. */
const legacyFingerprintOf = (
  who: Person,
  method: string,
  route: string,
  key: string,
  body: unknown,
) => fingerprints().legacy({ wawuUserId: who.id, method, route, key }, body);

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
      method: 'PUT',
      route: PIN_CHANGE_ROUTE,
      key,
      state: 'done',
      // Linked to the person's PIN in the transaction that changed it.
      resourceId: who.id,
      responseStatus: 200,
    });
  });

  it('the stored answer is the PIN state and nothing else: no PIN, and the body only as a keyed fingerprint (N3)', async () => {
    const first = pin();
    const who = await holder(first);
    const key = newKey();
    const next = pinOutsideFingerprint(who, key);
    await change(who, first, next, key).expect(200);
    const [row] = await rowsFor(who);
    expect(row.fingerprint).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/);
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
      expect(scannable(row)).not.toMatch(new RegExp(`(^|\\D)${secret}(\\D|$)`));
    }
    // The fingerprint is the request's own, keyed with the server's secret and carrying person, route and key: the
    // same request always gives the same text (the store compares them as text), another body or another key never does.
    const body = { newPin: next, newPinConfirmation: next };
    expect(row.fingerprint).toBe(
      fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, row.key, body),
    );
    expect(row.fingerprint).not.toBe(
      fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, row.key, {
        newPin: first,
        newPinConfirmation: first,
      }),
    );
    expect(row.fingerprint).not.toBe(
      fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, newKey(), body),
    );
    // And it is not the fast hash the payments use for a body.
    expect(row.fingerprint).not.toBe(bodyFingerprint(body));
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
    await t.prisma.moneyIdempotencyKey.create({
      data: {
        wawuUserId: who.id,
        method: 'PUT',
        route: PIN_CHANGE_ROUTE,
        key,
        fingerprint: fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, key, {
          newPin: next,
          newPinConfirmation: next,
        }),
        state: 'in_progress',
        claimId: randomUUID(),
      },
    });
    const waiting = await change(who, pin(), next, key).expect(409);
    expect(t.body(waiting).reason).toMatchObject({
      code: 'idempotency_in_progress',
      retryAfterSeconds: 2,
      message: PIN_KEY_WORDS['pin:change'].inProgress,
    });
    const reused = await change(who, first, pin(), key).expect(409);
    expect(t.body(reused).reason).toMatchObject({
      code: 'idempotency_key_reused',
      message: PIN_KEY_WORDS['pin:change'].reused,
    });
    expect((await pinRow(who)).failedTries).toBe(0);
    await t.approveWithPin(who, first).expect(200);
  });

  it('a claim older than a minute is a request that died before it changed anything: the key is taken again', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    const dead = await t.prisma.moneyIdempotencyKey.create({
      data: {
        wawuUserId: who.id,
        method: 'PUT',
        route: PIN_CHANGE_ROUTE,
        key,
        fingerprint: fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, key, {
          newPin: next,
          newPinConfirmation: next,
        }),
        state: 'in_progress',
        claimId: randomUUID(),
      },
    });
    await t.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "claimId" = ${dead.claimId}`;
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

  it('the key is linked to the PIN in the same transaction as the change: a request that lost its claim changes nothing', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const before = await pinRow(who);
    const service = t.app.get(TransactionPinService);
    const keys = t.app.get(IdempotencyService);
    const lost = {
      wawuUserId: who.id,
      method: 'PUT',
      route: PIN_CHANGE_ROUTE,
      key: newKey(),
      fingerprint: 'not-this-requests',
      claimId: randomUUID(),
    };
    await expect(
      service.change(who.id, { newPin: next, newPinConfirmation: next }, (tx) =>
        keys.attach(tx, lost, who.id),
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
    expect(scannable(row)).not.toContain(reset.code);
    expect(row.fingerprint).toMatch(/^hmac-sha256:v1:/);
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

describe('a request that died after the PIN changed (verifier D1, the store’s crash rule)', () => {
  const keyOf = (who: Person, route: string, key: string) => ({
    wawuUserId_method_route_key: {
      wawuUserId: who.id,
      method: route === PIN_CHANGE_ROUTE ? 'PUT' : 'POST',
      route,
      key,
    },
  });

  /**
   * The change really happened (the PIN is `next`, and the key names it),
   * and the request died before it stored its answer: the row is put back as
   * the crash would have left it.
   */
  async function diedAfterCommit(old: boolean) {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    await t.prisma.moneyIdempotencyKey.update({
      where: keyOf(who, PIN_CHANGE_ROUTE, key),
      data: { state: 'in_progress', responseStatus: null, responseBody: null },
    });
    if (old) {
      await t.prisma
        .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
    }
    return { first, next, who, key };
  }

  it('a repeat is told to wait while that request could still be running, in the PIN’s words', async () => {
    const { first, next, who, key } = await diedAfterCommit(false);
    const res = await change(who, first, next, key).expect(409);
    expect(t.body(res).reason).toMatchObject({
      code: 'idempotency_in_progress',
      message: PIN_KEY_WORDS['pin:change'].inProgress,
    });
  });

  it('once it cannot be, the repeat is answered with the PIN state as it stands, and the PIN is not looked at', async () => {
    const { next, who, key } = await diedAfterCommit(true);
    const res = await change(who, pin(), next, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(t.body<PinStateView>(res).data).toMatchObject({
      isSet: true,
      triesLeft: 5,
    });
    expect((await pinRow(who)).failedTries).toBe(0);
    const [row] = await rowsFor(who);
    expect(row.state).toBe('done');
    // And it was true: the PIN is the one this request set.
    await t.approveWithPin(who, next).expect(200);
  });

  it('N4: once it cannot be, and the PIN was changed again since, the repeat is 409 pin_changed_again: never a 200 for a PIN that is not the PIN', async () => {
    const { next, who, key } = await diedAfterCommit(true);
    const elsewhere = pin();
    // A second change, by another phone, after the first landed and before its repeat.
    await change(who, next, elsewhere, null).expect(200);
    await t.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
    for (const current of [next, pin(), null]) {
      // Whatever PIN rides along: the repeat is answered before it is looked at.
      const res = await change(who, current, next, key).expect(409);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(t.body(res).reason).toEqual({
        code: 'pin_changed_again',
        message: CHANGED_AGAIN_MESSAGE,
      });
      expect(t.body(res).data).toBeNull();
    }
    // No 200 was stored for the key, no try was used, and the PIN is theirs.
    const [row] = await rowsFor(who);
    expect(row).toMatchObject({
      state: 'in_progress',
      responseStatus: null,
      responseBody: null,
    });
    expect((await pinRow(who)).failedTries).toBe(0);
    await t.approveWithPin(who, elsewhere).expect(200);
    await t.approveWithPin(who, next).expect(403);
  });

  it('N4: the PIN was changed again to the very same PIN: it is still the PIN this request set, so the repeat is the 200', async () => {
    const { next, who, key } = await diedAfterCommit(true);
    await change(who, next, next, null).expect(200);
    await t.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
    const res = await change(who, pin(), next, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    await t.approveWithPin(who, next).expect(200);
  });

  it('N4 on the reset: the code was used and the answer lost, then the PIN was changed again: 409 pin_changed_again', async () => {
    const first = pin();
    const chosen = pin();
    const elsewhere = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const key = newKey();
    await confirm(who, { ...reset, newPin: chosen }, key).expect(200);
    await t.prisma.moneyIdempotencyKey.update({
      where: keyOf(who, PIN_RESET_CONFIRM_ROUTE, key),
      data: { state: 'in_progress', responseStatus: null, responseBody: null },
    });
    await change(who, chosen, elsewhere, null).expect(200);
    await t.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
    const res = await confirm(who, { ...reset, newPin: chosen }, key).expect(
      409,
    );
    expect(t.body(res).reason).toEqual({
      code: 'pin_changed_again',
      message: CHANGED_AGAIN_MESSAGE,
    });
    await t.approveWithPin(who, elsewhere).expect(200);
  });
});

describe('the one-minute rule, with literal numbers (verifier T2: V-S1, V-S2)', () => {
  const age = (claimId: string | null, seconds: number) =>
    t.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${seconds} seconds`}::interval WHERE "claimId" = ${claimId}`;

  it('V-S1 a claim that names nothing is still in progress at 55 s and is taken again at 61 s', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    const claimId = randomUUID();
    await t.prisma.moneyIdempotencyKey.create({
      data: {
        wawuUserId: who.id,
        method: 'PUT',
        route: PIN_CHANGE_ROUTE,
        key,
        fingerprint: fingerprintOf(who, 'PUT', PIN_CHANGE_ROUTE, key, {
          newPin: next,
          newPinConfirmation: next,
        }),
        state: 'in_progress',
        claimId,
      },
    });
    await age(claimId, 55);
    const young = await change(who, first, next, key).expect(409);
    expect(t.body(young).reason).toMatchObject({
      code: 'idempotency_in_progress',
    });
    await age(claimId, 61);
    const res = await change(who, first, next, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('V-S2 a claim that names the PIN with no answer waits at 55 s and is answered from the PIN at 61 s, with no try used', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    const [row] = await rowsFor(who);
    await t.prisma.moneyIdempotencyKey.update({
      where: {
        wawuUserId_method_route_key: {
          wawuUserId: who.id,
          method: 'PUT',
          route: PIN_CHANGE_ROUTE,
          key,
        },
      },
      data: { state: 'in_progress', responseStatus: null, responseBody: null },
    });
    await age(row.claimId, 55);
    await change(who, pin(), next, key).expect(409);
    await age(row.claimId, 61);
    const res = await change(who, pin(), next, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect((await pinRow(who)).failedTries).toBe(0);
  });
});

describe('the wallet gate answers before the key, on both routes (verifier T1: V-G1, V-G2)', () => {
  it('V-G1 a person with no wallet who sends a usable key to /reset/confirm gets the wallet answer and no key row', async () => {
    const stranger = t.person();
    const res = await t
      .http()
      .post(CONFIRM)
      .set('Authorization', stranger.auth)
      .set('Idempotency-Key', newKey())
      .send({
        resetId: randomUUID(),
        code: '123456',
        newPin: '4821',
        newPinConfirmation: '4821',
      });
    expect(res.status).toBe(409);
    expect(t.body(res).reason).toMatchObject({ code: 'wallet_not_open' });
    expect(await rowsFor(stranger)).toEqual([]);
  });

  it('V-G2 the same person with an UNUSABLE key still gets the wallet answer, not idempotency_key_required: the gate is first', async () => {
    const stranger = t.person();
    for (const key of ['x', 'has space in it', 'a'.repeat(129)]) {
      const res = await t
        .http()
        .post(CONFIRM)
        .set('Authorization', stranger.auth)
        .set('Idempotency-Key', key)
        .send({
          resetId: randomUUID(),
          code: '123456',
          newPin: '4821',
          newPinConfirmation: '4821',
        });
      expect(res.status).toBe(409);
      expect(t.body(res).reason).toMatchObject({ code: 'wallet_not_open' });
    }
  });

  it('and the same on PUT /money/pin: no wallet answers first, whatever key rides along', async () => {
    const stranger = t.person();
    const res = await change(stranger, '1234', pin(), 'x').expect(409);
    expect(t.body(res).reason).toMatchObject({ code: 'wallet_not_open' });
  });
});

describe('the PIN’s own words for the store’s refusals (N1)', () => {
  async function running(route: string, who: Person, body: unknown) {
    const key = newKey();
    await t.prisma.moneyIdempotencyKey.create({
      data: {
        wawuUserId: who.id,
        method: route === PIN_CHANGE_ROUTE ? 'PUT' : 'POST',
        route,
        key,
        fingerprint: fingerprintOf(
          who,
          route === PIN_CHANGE_ROUTE ? 'PUT' : 'POST',
          route,
          key,
          body,
        ),
        state: 'in_progress',
        claimId: randomUUID(),
      },
    });
    return key;
  }

  it('the change: still going through, and key already used, are about the PIN and say nothing of a payment', async () => {
    const first = pin();
    const next = pin();
    const other = pin();
    const who = await holder(first);
    const key = await running(PIN_CHANGE_ROUTE, who, {
      newPin: next,
      newPinConfirmation: next,
    });
    const waiting = await change(who, first, next, key).expect(409);
    expect(t.body(waiting).reason).toEqual({
      code: 'idempotency_in_progress',
      message:
        'Your PIN change is still going through. Check again in a moment.',
      retryAfterSeconds: 2,
    });
    const reused = await change(who, first, other, key).expect(409);
    expect(t.body(reused).reason).toEqual({
      code: 'idempotency_key_reused',
      message: 'Start again to change your PIN.',
    });
    for (const res of [waiting, reused]) {
      expect(res.text).not.toMatch(/payment|pay\b/i);
    }
  });

  it('the reset: the same two, worded for a reset', async () => {
    const first = pin();
    const chosen = pin();
    const other = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const key = await running(PIN_RESET_CONFIRM_ROUTE, who, {
      ...reset,
      newPin: chosen,
      newPinConfirmation: chosen,
    });
    const waiting = await confirm(
      who,
      { ...reset, newPin: chosen },
      key,
    ).expect(409);
    expect(t.body(waiting).reason).toEqual({
      code: 'idempotency_in_progress',
      message:
        'Your PIN reset is still going through. Check again in a moment.',
      retryAfterSeconds: 2,
    });
    const reused = await confirm(who, { ...reset, newPin: other }, key).expect(
      409,
    );
    expect(t.body(reused).reason).toEqual({
      code: 'idempotency_key_reused',
      message: 'Start again to reset your PIN.',
    });
    for (const res of [waiting, reused]) {
      expect(res.text).not.toMatch(/payment|pay\b/i);
    }
  });

  it('a link that fails because the claim was taken over says it in the same words', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const service = t.app.get(TransactionPinService);
    const keyed = t.app.get(PinRequestKeys);
    const lost = {
      wawuUserId: who.id,
      method: 'PUT',
      route: PIN_CHANGE_ROUTE,
      key: newKey(),
      fingerprint: 'not-this-requests',
      claimId: randomUUID(),
    };
    await expect(
      keyed.under(lost, who.id, (inTransaction) =>
        service.change(
          who.id,
          { newPin: next, newPinConfirmation: next },
          inTransaction,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'idempotency_in_progress',
      response: {
        reason: {
          message:
            'Your PIN change is still going through. Check again in a moment.',
        },
      },
    });
    await t.approveWithPin(who, first).expect(200);
  });
});

describe('the fingerprint is keyed with a server secret (N3)', () => {
  it('a row’s fingerprint is the HMAC under a key derived from WAWU_ID_INTERNAL_SERVICE_KEY with the fixed label, written out here independently', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    const [row] = await rowsFor(who);
    const secret =
      t.app.get(ConfigService).get<string>(FINGERPRINT_SECRET_KEY) ||
      'dev-internal-service-key-not-secret';
    const derived = createHmac('sha256', secret)
      .update('wawu-hub:pin-request-fingerprint:v1')
      .digest();
    expect(FINGERPRINT_LABEL).toBe('wawu-hub:pin-request-fingerprint:v1');
    const message = JSON.stringify([
      who.id,
      'PUT',
      PIN_CHANGE_ROUTE,
      key,
      `{"newPin":"${next}","newPinConfirmation":"${next}"}`,
    ]);
    expect(row.fingerprint).toBe(
      `${FINGERPRINT_PREFIX}${createHmac('sha256', derived).update(message).digest('hex')}`,
    );
  });

  it('with the table and no secret, none of the 10,000 PINs matches the row; with the secret exactly one does', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    const [row] = await rowsFor(who);
    const id = {
      wawuUserId: who.id,
      method: 'PUT',
      route: PIN_CHANGE_ROUTE,
      key,
    };
    const guesser = new PinRequestFingerprints(
      new ConfigService({
        [FINGERPRINT_SECRET_KEY]: 'a-secret-the-reader-guessed',
      }),
    );
    const real = fingerprints();
    const all = Array.from({ length: 10_000 }, (_, i) =>
      String(i).padStart(4, '0'),
    );
    const bodyOf = (p: string) => ({ newPin: p, newPinConfirmation: p });
    expect(
      all.filter((p) => guesser.of(id, bodyOf(p)) === row.fingerprint),
    ).toEqual([]);
    expect(
      all.filter((p) => real.of(id, bodyOf(p)) === row.fingerprint),
    ).toEqual([next]);
  });

  it('another secret, another person, another route, another key, another body: another fingerprint', () => {
    const id = {
      wawuUserId: 'u1',
      method: 'PUT',
      route: PIN_CHANGE_ROUTE,
      key: 'key-0001-key',
    };
    const body = { newPin: '1234', newPinConfirmation: '1234' };
    const a = new PinRequestFingerprints(
      new ConfigService({ [FINGERPRINT_SECRET_KEY]: 'one-secret-one' }),
    );
    const b = new PinRequestFingerprints(
      new ConfigService({ [FINGERPRINT_SECRET_KEY]: 'two-secret-two' }),
    );
    const base = a.of(id, body);
    expect(a.of(id, { ...body })).toBe(base);
    expect(b.of(id, body)).not.toBe(base);
    expect(a.of({ ...id, wawuUserId: 'u2' }, body)).not.toBe(base);
    expect(a.of({ ...id, route: PIN_RESET_CONFIRM_ROUTE }, body)).not.toBe(
      base,
    );
    expect(a.of({ ...id, key: 'key-0002-key' }, body)).not.toBe(base);
    expect(a.of(id, { newPin: '1235', newPinConfirmation: '1235' })).not.toBe(
      base,
    );
  });

  it('production does not start without the secret (the Hub already requires it: no new setting)', () => {
    const was = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => new PinRequestFingerprints(new ConfigService({}))).toThrow(
        /WAWU_ID_INTERNAL_SERVICE_KEY/,
      );
      expect(
        () =>
          new PinRequestFingerprints(
            new ConfigService({
              [FINGERPRINT_SECRET_KEY]: 'set-in-production',
            }),
          ),
      ).not.toThrow();
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

describe('rows written before round 3 are read as before until they expire (N3)', () => {
  async function oldRow(
    who: Person,
    route: string,
    key: string,
    body: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const method = route === PIN_CHANGE_ROUTE ? 'PUT' : 'POST';
    return t.prisma.moneyIdempotencyKey.create({
      data: {
        wawuUserId: who.id,
        method,
        route,
        key,
        fingerprint: await legacyFingerprintOf(who, method, route, key, body),
        state: 'in_progress',
        claimId: randomUUID(),
        ...extra,
      },
    });
  }

  it('a finished old row replays its answer, byte for byte, with no try used', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    const lost = await change(who, first, next, key).expect(200);
    // Rewrite the row the way the old code wrote it.
    await t.prisma.moneyIdempotencyKey.updateMany({
      where: { wawuUserId: who.id, key },
      data: {
        fingerprint: await legacyFingerprintOf(
          who,
          'PUT',
          PIN_CHANGE_ROUTE,
          key,
          {
            newPin: next,
            newPinConfirmation: next,
          },
        ),
      },
    });
    const again = await change(who, first, next, key).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.text).toBe(lost.text);
    expect((await pinRow(who)).failedTries).toBe(0);
    // The row stays as it was: nothing rewrites it.
    expect((await rowsFor(who))[0].fingerprint).toMatch(/^\$argon2id\$/);
  });

  it('an old row still running: the repeat waits; another body is key_reused; both in the PIN’s words', async () => {
    const first = pin();
    const next = pin();
    const other = pin();
    const who = await holder(first);
    const key = newKey();
    await oldRow(who, PIN_CHANGE_ROUTE, key, {
      newPin: next,
      newPinConfirmation: next,
    });
    const waiting = await change(who, first, next, key).expect(409);
    expect(t.body(waiting).reason).toMatchObject({
      code: 'idempotency_in_progress',
      message: PIN_KEY_WORDS['pin:change'].inProgress,
    });
    const reused = await change(who, first, other, key).expect(409);
    expect(t.body(reused).reason).toMatchObject({
      code: 'idempotency_key_reused',
      message: PIN_KEY_WORDS['pin:change'].reused,
    });
  });

  it('an old row of a request that landed and died before its answer: after the minute it is answered from the PIN, and N4 applies to it too', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    await change(who, first, next, key).expect(200);
    const body = { newPin: next, newPinConfirmation: next };
    await t.prisma.moneyIdempotencyKey.updateMany({
      where: { wawuUserId: who.id, key },
      data: {
        fingerprint: await legacyFingerprintOf(
          who,
          'PUT',
          PIN_CHANGE_ROUTE,
          key,
          body,
        ),
        state: 'in_progress',
        responseStatus: null,
        responseBody: null,
      },
    });
    const age = () =>
      t.prisma
        .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
    await age();
    const ok = await change(who, pin(), next, key).expect(200);
    expect(ok.headers['idempotent-replayed']).toBe('true');
    // Put it back and change the PIN again: the same old row now answers 409.
    await t.prisma.moneyIdempotencyKey.updateMany({
      where: { wawuUserId: who.id, key },
      data: { state: 'in_progress', responseStatus: null, responseBody: null },
    });
    await change(who, next, pin(), null).expect(200);
    await age();
    const refused = await change(who, pin(), next, key).expect(409);
    expect(t.body(refused).reason).toMatchObject({ code: 'pin_changed_again' });
  });

  it('an old row of a request that died before it changed anything is taken again, and the new row is written in the keyed form', async () => {
    const first = pin();
    const next = pin();
    const who = await holder(first);
    const key = newKey();
    const dead = await oldRow(who, PIN_CHANGE_ROUTE, key, {
      newPin: next,
      newPinConfirmation: next,
    });
    await t.prisma
      .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${STALE_CLAIM_SECONDS + 5} seconds`}::interval WHERE "claimId" = ${dead.claimId}`;
    const res = await change(who, first, next, key).expect(200);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const [row] = await rowsFor(who);
    expect(row.state).toBe('done');
    expect(row.fingerprint).toMatch(/^hmac-sha256:v1:/);
    await t.approveWithPin(who, next).expect(200);
  });

  it('an old row on the reset route is read the same way', async () => {
    const first = pin();
    const chosen = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const key = newKey();
    const landed = await confirm(who, { ...reset, newPin: chosen }, key).expect(
      200,
    );
    await t.prisma.moneyIdempotencyKey.updateMany({
      where: { wawuUserId: who.id, key },
      data: {
        fingerprint: await legacyFingerprintOf(
          who,
          'POST',
          PIN_RESET_CONFIRM_ROUTE,
          key,
          {
            ...reset,
            newPin: chosen,
            newPinConfirmation: chosen,
          },
        ),
      },
    });
    const again = await confirm(who, { ...reset, newPin: chosen }, key).expect(
      200,
    );
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.text).toBe(landed.text);
  });
});

describe('the keys are kept for a while and then go (the store’s own purge)', () => {
  it('PIN keys older than the store’s keep time are purged with the payments’, and newer ones stay', async () => {
    const who = await holder(pin());
    const hours = t.app.get(PaymentSettings).idempotencyKeyHours;
    expect(hours).toBeGreaterThanOrEqual(24);
    const mk = async (hoursAgo: number) => {
      const key = newKey();
      await t.prisma.moneyIdempotencyKey.create({
        data: {
          wawuUserId: who.id,
          method: 'PUT',
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
        .$executeRaw`UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - ${`${hoursAgo} hours`}::interval WHERE "key" = ${key} AND "wawuUserId" = ${who.id}`;
      return key;
    };
    const old = await mk(hours + 1);
    const fresh = await mk(hours - 1);
    expect(await t.app.get(IdempotencyService).purge()).toBeGreaterThanOrEqual(
      1,
    );
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
      await t.prisma.moneyIdempotencyKey.findMany({
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
