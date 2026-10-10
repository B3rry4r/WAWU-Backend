import {
  digits,
  Money14App,
  phoneKey,
  type Person,
  TIMEOUT_MS,
} from '../../../../test/money/pin-approval-harness';
import type {
  ApprovalDeviceView,
  PinResetView,
  PinStateView,
} from '../../money-view.type';
import { RESET_WINDOW_MS } from '../pin-reset-config';

/**
 * Forgot PIN (W37) over HTTP (task MONEY-14): a code texted through
 * Fintava's `POST /sms/send` to the phone the BVN check proved, then the
 * code and a new PIN. Real database, real tokens, the real Fintava client
 * over a socket to a stand-in (FintavaDouble). Each test is a new person.
 *
 * The rule under test throughout: a reset is never weaker than the PIN it
 * replaces. The code goes only to the proved phone; it is single use, dies
 * after five wrong tries or its time, only the newest works; the texts are
 * limited; nothing secret is logged or answered.
 */

jest.setTimeout(60_000);

const RESET = '/api/hub/money/pin/reset';
const CONFIRM = '/api/hub/money/pin/reset/confirm';

const t = new Money14App({});

/**
 * The PINs this file types, fresh each run (FIX-03). The harness never
 * makes a phone, BVN or NIN that ends in one of them, so the leak scan at
 * the end can only find a PIN where it was really written: before this, a
 * masked phone (`+234 *** *** 1590`) whose random last four digits equalled
 * a fixed test PIN failed the scan about once in 30 runs.
 */
const pins = t.reservePins(60);
function pin(): string {
  const next = pins.shift();
  if (!next) throw new Error('the PIN pool is used up: reserve more');
  secrets.add(next);
  return next;
}

beforeAll(() => t.start());
afterAll(() => t.stop());
beforeEach(() => t.installDefaults());

/** Everything secret this file sent or was sent: codes and PINs. */
const secrets = new Set<string>();

function start(who: Person) {
  return t.http().post(RESET).set('Authorization', who.auth);
}

function confirm(
  who: Person,
  body: {
    resetId: string;
    code: string;
    newPin: string;
    newPinConfirmation?: string;
  },
) {
  secrets.add(body.code);
  secrets.add(body.newPin);
  return t
    .http()
    .post(CONFIRM)
    .set('Authorization', who.auth)
    .send({ newPinConfirmation: body.newPin, ...body });
}

/** A person whose BVN check proved their phone, with `pin` set. */
async function holder(first: string = pin(), phone?: string): Promise<Person> {
  const who = t.person(phone);
  secrets.add(first);
  await t.bvnChecked(who);
  await t.openWallet(who);
  await t.setPin(who, first);
  return who;
}

async function resetOf(who: Person): Promise<PinResetView> {
  const res = await start(who).expect(201);
  return t.body<PinResetView>(res).data!;
}

/** Moves a reset back in time, as if it was asked for `ms` ago. */
async function age(resetId: string, ms: number): Promise<void> {
  const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
    where: { id: resetId },
  });
  await t.prisma.transactionPinReset.update({
    where: { id: resetId },
    data: {
      createdAt: new Date(row.createdAt.getTime() - ms),
      expiresAt: new Date(row.expiresAt.getTime() - ms),
      resendAvailableAt: new Date(row.resendAvailableAt.getTime() - ms),
    },
  });
}

describe('a user who forgot their PIN can reset it with a code and pay again', () => {
  it('locked out after five wrong PINs, a code to the proved phone sets a new PIN; the new one approves, the old one does not', async () => {
    const oldPin = pin();
    const wrongPin = pin();
    const newPin = pin();
    const who = await holder(oldPin);
    for (let i = 0; i < 4; i++) {
      await t.approveWithPin(who, wrongPin).expect(403);
    }
    await t.approveWithPin(who, wrongPin).expect(423);
    // Even the right PIN is refused while locked.
    await t.approveWithPin(who, oldPin).expect(423);

    const before = Date.now();
    const reset = await resetOf(who);
    expect(reset.sentTo).toBe(`+234 *** *** ${who.phone.slice(-4)}`);
    expect(Date.parse(reset.resendAvailableAt) - before).toBeGreaterThan(
      55_000,
    );
    expect(Date.parse(reset.resendAvailableAt) - before).toBeLessThan(65_000);
    expect(Date.parse(reset.expiresAt) - before).toBeGreaterThan(295_000);
    expect(Date.parse(reset.expiresAt) - before).toBeLessThan(305_000);

    // Exactly one text, to the proved phone with its country code.
    const texts = t.texts();
    expect(texts).toHaveLength(1);
    expect(texts[0].to).toBe(who.phone);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    expect(texts[0].sms).toContain('5 minutes');

    const res = await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin,
    }).expect(200);
    const state = t.body<PinStateView>(res).data!;
    expect(state).toMatchObject({
      isSet: true,
      triesLeft: 5,
      lockedUntil: null,
    });

    // The check every debit makes: the new PIN approves, the old one does not.
    await t.approveWithPin(who, newPin).expect(200);
    const old = await t.approveWithPin(who, oldPin).expect(403);
    expect(t.body(old).reason).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });

    // Stored: only a hash of the code, now used; the PIN's hash changed.
    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.codeHash).toMatch(/^\$argon2id\$/);
    expect(row.codeHash).not.toContain(code);
    expect(row.usedAt).not.toBeNull();
    expect(row.sendState).toBe('sent');
    expect(row.phone).toBe(who.phone);
  });

  it('the code goes to the phone the BVN check proved, never to a number the token names later', async () => {
    const who = await holder();
    // The account's phone changes at WAWU ID after the BVN check: the token
    // now names another number, the proved one stays on file.
    const moved = t.reissue(who, t.newPhone('81'));
    expect(moved.phone).not.toBe(who.phone);
    await resetOf(moved);
    expect(t.texts().map((x) => x.to)).toEqual([who.phone]);
  });

  it('a person with no wallet is 409 wallet_not_open from the wallet gate, and nothing is sent', async () => {
    const who = t.person();
    await t.bvnChecked(who);
    for (const res of [
      await start(who),
      await confirm(who, {
        resetId: '00000000-0000-4000-8000-000000000000',
        code: digits(6),
        newPin: pin(),
      }),
    ]) {
      expect(res.status).toBe(409);
      expect(t.body(res).reason?.code).toBe('wallet_not_open');
    }
    expect(t.texts()).toHaveLength(0);
  });

  it('a wallet with no phone a BVN check proved (a row written outside the opening flow) gets no text', async () => {
    const who = t.person();
    await t.openWallet(who);
    await t.setPin(who, pin());
    const res = await start(who).expect(409);
    expect(t.body(res).reason?.code).toBe('wallet_not_open');
    expect(t.texts()).toHaveLength(0);
  });

  it('a person without a PIN is 409 pin_not_set, and nothing is sent', async () => {
    const who = t.person();
    await t.bvnChecked(who);
    await t.openWallet(who);
    const res = await start(who).expect(409);
    expect(t.body(res).reason?.code).toBe('pin_not_set');
    expect(t.texts()).toHaveLength(0);
  });

  it('no token is 401, as every route (the token, not the code)', async () => {
    await t.http().post(RESET).expect(401);
    await t
      .http()
      .post(CONFIRM)
      .send({ resetId: '00000000-0000-4000-8000-000000000000' })
      .expect(401);
  });
});

describe('asking again', () => {
  it('a double tap is one text: five starts at once answer the same reset', async () => {
    const who = await holder();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => start(who)),
    );
    expect(answers.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const ids = new Set(
      answers.map((r) => t.body<PinResetView>(r).data!.resetId),
    );
    expect(ids.size).toBe(1);
    expect(t.texts()).toHaveLength(1);
  });

  it('before Resend opens it answers the same reset and sends nothing; after, a new code, and the old one stops working', async () => {
    const who = await holder();
    const first = await resetOf(who);
    const firstCode = t.lastCode(who.phone);
    secrets.add(firstCode);
    const again = await resetOf(who);
    expect(again).toEqual(first);
    expect(t.texts()).toHaveLength(1);

    await age(first.resetId, 61_000);
    const second = await resetOf(who);
    expect(second.resetId).not.toBe(first.resetId);
    expect(t.texts()).toHaveLength(2);
    const secondCode = t.lastCode(who.phone);
    secrets.add(secondCode);

    const stale = await confirm(who, {
      resetId: first.resetId,
      code: firstCode,
      newPin: pin(),
    }).expect(400);
    expect(t.body(stale).reason).toMatchObject({
      code: 'reset_code_invalid',
      triesLeft: 0,
    });
    await confirm(who, {
      resetId: second.resetId,
      code: secondCode,
      newPin: pin(),
    }).expect(200);
  });
});

describe('a code is not easier to guess than the PIN', () => {
  it('five wrong codes kill it: 4, 3, 2, 1 then 0 tries left, and the right code is refused after', async () => {
    const first = pin();
    const unused = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    const wrong = code === '000000' ? '000001' : '000000';
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await confirm(who, {
        resetId: reset.resetId,
        code: wrong,
        newPin: unused,
      }).expect(400);
      expect(t.body(res).reason?.code).toBe('reset_code_invalid');
      left.push(t.body(res).reason!.triesLeft!);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const late = await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: unused,
    }).expect(400);
    expect(t.body(late).reason).toMatchObject({
      code: 'reset_code_invalid',
      triesLeft: 0,
    });
    // The PIN is the old one, and wrong codes used none of its tries.
    const state = t.body<PinStateView>(await t.pinState(who)).data!;
    expect(state.triesLeft).toBe(5);
    await t.approveWithPin(who, first).expect(200);
  });

  it('ten wrong codes at once get exactly five compared', async () => {
    const who = await holder();
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    const wrong = code === '999999' ? '999998' : '999999';
    const unused = pin();
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        confirm(who, { resetId: reset.resetId, code: wrong, newPin: unused }),
      ),
    );
    expect(answers.every((r) => r.status === 400)).toBe(true);
    const left = answers
      .map((r) => t.body(r).reason!.triesLeft!)
      .sort((a, b) => b - a);
    expect(left).toEqual([4, 3, 2, 1, 0, 0, 0, 0, 0, 0]);
    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.failedTries).toBe(5);
    await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: unused,
    }).expect(400);
  });

  it('a code that has expired is refused', async () => {
    const who = await holder();
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    await age(reset.resetId, 301_000);
    const res = await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: pin(),
    }).expect(400);
    expect(t.body(res).reason).toMatchObject({
      code: 'reset_code_invalid',
      triesLeft: 0,
    });
  });

  it('a code works once: two right confirms at once set one PIN', async () => {
    const who = await holder();
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    const [pinA, pinB] = [pin(), pin()];
    const answers = await Promise.all([
      confirm(who, { resetId: reset.resetId, code, newPin: pinA }),
      confirm(who, { resetId: reset.resetId, code, newPin: pinB }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = answers[0].status === 200 ? pinA : pinB;
    const loser = winner === pinA ? pinB : pinA;
    await t.approveWithPin(who, winner).expect(200);
    await t.approveWithPin(who, loser).expect(403);
    await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: pin(),
    }).expect(400);
  });

  it("someone else's reset is refused like a wrong code, and changes nothing of theirs", async () => {
    const [ownerPin, otherPin] = [pin(), pin()];
    const owner = await holder(ownerPin);
    const other = await holder(otherPin);
    const reset = await resetOf(owner);
    const code = t.lastCode(owner.phone);
    secrets.add(code);
    const res = await confirm(other, {
      resetId: reset.resetId,
      code,
      newPin: pin(),
    }).expect(400);
    expect(t.body(res).reason?.code).toBe('reset_code_invalid');
    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.failedTries).toBe(0);
    await t.approveWithPin(owner, ownerPin).expect(200);
    await t.approveWithPin(other, otherPin).expect(200);
  });

  it('two different new PINs are 400 pin_mismatch and use no try of the code', async () => {
    const who = await holder();
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    const [newPin, typo] = [pin(), pin()];
    const res = await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin,
      newPinConfirmation: typo,
    }).expect(400);
    expect(t.body(res).reason?.code).toBe('pin_mismatch');
    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.failedTries).toBe(0);
    await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin,
    }).expect(200);
  });

  it('a code or id in an unexpected format is a 400 from validation, using no try', async () => {
    const who = await holder();
    const reset = await resetOf(who);
    const [junk, newPin] = [digits(6), pin()];
    for (const body of [
      {
        resetId: reset.resetId,
        code: `${junk.slice(0, 3)} ${junk.slice(3)}`,
        newPin,
      },
      {
        resetId: reset.resetId,
        code: `${junk.slice(0, 2)}a${junk.slice(3)}`,
        newPin,
      },
      { resetId: 'not-a-uuid', code: junk, newPin },
      { resetId: reset.resetId, code: junk, newPin: `${newPin}5` },
    ]) {
      const res = await confirm(who, body).expect(400);
      expect(t.body(res).reason).toBeUndefined();
    }
    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.failedTries).toBe(0);
  });
});

describe('texts are limited and paid for once', () => {
  it('the sixth text in 24 hours is 429 reset_codes_exhausted with when to try again; nothing is sent', async () => {
    const who = await holder();
    let firstId = '';
    for (let i = 0; i < 5; i++) {
      const r = await resetOf(who);
      if (i === 0) firstId = r.resetId;
      await age(r.resetId, 61_000);
    }
    expect(t.texts()).toHaveLength(5);
    const res = await start(who).expect(429);
    const reason = t.body(res).reason!;
    expect(reason.code).toBe('reset_codes_exhausted');
    // The oldest counted text leaves the window first.
    const oldest = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: firstId },
    });
    const expected = Math.ceil(
      (oldest.createdAt.getTime() + RESET_WINDOW_MS - Date.now()) / 1000,
    );
    expect(Math.abs(reason.retryAfterSeconds! - expected)).toBeLessThan(5);
    expect(t.texts()).toHaveLength(5);
  });

  it('the limit is per phone too: a second account with the same proved phone shares it', async () => {
    const phone = t.newPhone();
    const a = await holder(pin(), phone);
    const b = await holder(pin(), phone);
    for (let i = 0; i < 3; i++) await age((await resetOf(a)).resetId, 61_000);
    for (let i = 0; i < 2; i++) await age((await resetOf(b)).resetId, 61_000);
    const res = await start(b).expect(429);
    expect(t.body(res).reason?.code).toBe('reset_codes_exhausted');
  });

  it('a text Fintava refuses (the sandbox answer) is 503, is not counted and its code never works; asking again sends at once', async () => {
    const who = await holder();
    // What the sandbox answered on 3 Oct 2026 (mobile repo
    // docs/fintava/sandbox/35-money14-pin-reset.md).
    t.double.on('POST', '/sms/send', {
      status: 400,
      body: {
        status: 400,
        timestamp: '2026-10-03T10:47:38.186Z',
        message: ['amount must be greater than or equal to 1'],
        path: '/api/dev/sms/send',
      },
    });
    const res = await start(who).expect(503);
    expect(t.body(res).reason).toMatchObject({
      code: 'provider_unreachable',
    });
    const code = t.lastCode(who.phone);
    secrets.add(code);
    const rows = await t.prisma.transactionPinReset.findMany({
      where: { wawuUserId: who.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sendState).toBe('failed');
    await confirm(who, {
      resetId: rows[0].id,
      code,
      newPin: pin(),
    }).expect(400);

    t.double.on('POST', '/sms/send', { status: 200, body: {} });
    const again = await resetOf(who);
    expect(again.resetId).not.toBe(rows[0].id);
    expect(t.texts()).toHaveLength(2);
  });

  it('a text whose answer is lost is 503, never sent again blindly, and its code still works if it arrived', async () => {
    const who = await holder();
    t.double.on('POST', '/sms/send', {
      status: 200,
      body: {},
      delayMs: TIMEOUT_MS + 500,
    });
    const lost = await start(who).expect(503);
    expect(t.body(lost).reason).toMatchObject({
      code: 'provider_unreachable',
    });
    expect(t.body(lost).reason!.retryAfterSeconds).toBeGreaterThan(0);
    const row = await t.prisma.transactionPinReset.findFirstOrThrow({
      where: { wawuUserId: who.id },
    });
    expect(row.sendState).toBe('unknown');

    // Asked again before Resend opens: the same reset, nothing sent.
    t.double.on('POST', '/sms/send', { status: 200, body: {} });
    const again = await resetOf(who);
    expect(again.resetId).toBe(row.id);
    expect(t.texts()).toHaveLength(1);

    const code = t.lastCode(who.phone);
    secrets.add(code);
    const newPin = pin();
    await confirm(who, {
      resetId: row.id,
      code,
      newPin,
    }).expect(200);
    await t.approveWithPin(who, newPin).expect(200);
  });
});

describe('a reset turns biometric approval off', () => {
  it('the phone registered before the reset no longer approves', async () => {
    const first = pin();
    const who = await holder(first);
    await t
      .http()
      .put('/api/hub/money/device')
      .set('Authorization', who.auth)
      .set('X-Transaction-Pin', first)
      .send({ publicKey: phoneKey().publicKey, biometric: 'fingerprint' })
      .expect(200);
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: pin(),
    }).expect(200);
    const device = await t
      .http()
      .get('/api/hub/money/device')
      .set('Authorization', who.auth)
      .expect(200);
    expect(t.body<ApprovalDeviceView>(device).data!.registered).toBe(false);
    await t
      .http()
      .post('/api/hub/money/device/challenge')
      .set('Authorization', who.auth)
      .expect(403);
  });
});

describe('a PIN change ends an open reset (BACKEND_GAPS G-50)', () => {
  it('a code texted before the person changed their PIN is refused afterwards, and the PIN they chose stays', async () => {
    const first = pin();
    const chosen = pin();
    const attacker = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);

    await t
      .http()
      .put('/api/hub/money/pin')
      .set('Authorization', who.auth)
      .set('X-Transaction-Pin', first)
      .send({ newPin: chosen, newPinConfirmation: chosen })
      .expect(200);

    const refused = await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: attacker,
    }).expect(400);
    expect(t.body(refused).reason).toMatchObject({
      code: 'reset_code_invalid',
      triesLeft: 0,
    });
    // The change stands: the PIN chosen approves, the one the old code would have set does not.
    await t.approveWithPin(who, chosen).expect(200);
    await t.approveWithPin(who, attacker).expect(403);

    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.supersededAt).not.toBeNull();
    expect(row.usedAt).toBeNull();
  });

  it('a change made while no reset is open changes nothing about other people’s resets', async () => {
    const mine = pin();
    const theirs = pin();
    const me = await holder(mine);
    const other = await holder(theirs);
    const reset = await resetOf(other);
    const newPin = pin();
    await t
      .http()
      .put('/api/hub/money/pin')
      .set('Authorization', me.auth)
      .set('X-Transaction-Pin', mine)
      .send({ newPin, newPinConfirmation: newPin })
      .expect(200);
    const row = await t.prisma.transactionPinReset.findUniqueOrThrow({
      where: { id: reset.resetId },
    });
    expect(row.supersededAt).toBeNull();
    const code = t.lastCode(other.phone);
    secrets.add(code);
    await confirm(other, {
      resetId: reset.resetId,
      code,
      newPin: pin(),
    }).expect(200);
  });

  it('a reset stores the new PIN only as an argon2id hash (FIX-03 verifier)', async () => {
    const first = pin();
    const chosen = pin();
    const who = await holder(first);
    const reset = await resetOf(who);
    const code = t.lastCode(who.phone);
    secrets.add(code);
    await confirm(who, {
      resetId: reset.resetId,
      code,
      newPin: chosen,
    }).expect(200);
    const stored = await t.prisma.transactionPin.findUniqueOrThrow({
      where: { wawuUserId: who.id },
    });
    expect(stored.pinHash).toMatch(/^\$argon2id\$/);
    expect(stored.pinHash).not.toContain(chosen);
  });
});

describe('nothing secret leaves the server', () => {
  it('no code and no PIN sent in this file is in any log line, any answer, or any stored column but a hash', async () => {
    expect(secrets.size).toBeGreaterThan(10);
    const logs = t.log.lines.join('\n');
    const answers = t.answered.join('\n');
    const rows = JSON.stringify(
      await t.prisma.transactionPinReset.findMany({
        where: { wawuUserId: { in: t.users } },
        select: {
          id: true,
          phone: true,
          sendState: true,
          failedTries: true,
          expiresAt: true,
        },
      }),
    );
    // Ids, times, durations, ports and process ids are not secrets, and
    // their digits could look like a PIN (a busy run once logged a duration
    // that matched one).
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
    // The one refusal the client logs names the operation and status only.
    expect(logs).toContain('send SMS: refused HTTP 400');
  });
});
