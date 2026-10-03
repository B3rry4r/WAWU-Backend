import {
  Money14App,
  type Person,
  type PhoneKey,
  phoneKey,
  signApproval,
} from '../../../../test/money/pin-approval-harness';
import type {
  ApprovalChallengeView,
  ApprovalDeviceView,
  PinStateView,
} from '../../money-view.type';

/**
 * Approving with a fingerprint or a face (W11, W35; R-26) over HTTP (task
 * MONEY-14). The phone holds a P-256 key only its biometric unlocks; it
 * registers the public half with the PIN and approves a request by signing
 * a one-time challenge with that request. These tests sign with Node's
 * crypto exactly what the app signs (test/money/pin-approval-harness.ts),
 * against a real database and real tokens.
 *
 * `POST /money/approval/verify` is the check every debit makes
 * (`@RequireApproval()`): no debit route is served yet (WALLET-07, WALLET-09,
 * MONEY-17 serve them).
 */

jest.setTimeout(60_000);

const DEVICE = '/api/hub/money/device';
const CHALLENGE = '/api/hub/money/device/challenge';
const VERIFY = '/api/hub/money/approval/verify';

const t = new Money14App({});

beforeAll(() => t.start());
afterAll(() => t.stop());

async function holder(pin = '2741'): Promise<Person> {
  const who = t.person();
  await t.openWallet(who);
  await t.setPin(who, pin);
  return who;
}

function register(who: Person, key: PhoneKey, pin = '2741') {
  return t
    .http()
    .put(DEVICE)
    .set('Authorization', who.auth)
    .set('X-Transaction-Pin', pin)
    .send({ publicKey: key.publicKey, biometric: 'fingerprint' });
}

async function registered(who: Person, key = phoneKey(), pin = '2741') {
  const res = await register(who, key, pin).expect(200);
  return { key, view: t.body<ApprovalDeviceView>(res).data! };
}

async function challengeFor(who: Person): Promise<ApprovalChallengeView> {
  const res = await t
    .http()
    .post(CHALLENGE)
    .set('Authorization', who.auth)
    .expect(201);
  return t.body<ApprovalChallengeView>(res).data!;
}

/** POST /money/approval/verify with a biometric approval. */
function approve(who: Person, header: string, pin?: string) {
  const req = t
    .http()
    .post(VERIFY)
    .set('Authorization', who.auth)
    .set('X-Device-Approval', header);
  return pin ? req.set('X-Transaction-Pin', pin) : req;
}

/** The phone's approval for POST /money/approval/verify with no body. */
function approvalFor(key: PhoneKey, c: ApprovalChallengeView): string {
  return signApproval(key, c, { method: 'POST', url: VERIFY });
}

async function triesLeft(who: Person): Promise<number> {
  return t.body<PinStateView>(await t.pinState(who).expect(200)).data!
    .triesLeft;
}

describe('turning it on for a phone (W35)', () => {
  it('a user can register this phone with the PIN; the answer names it, and GET reads it back', async () => {
    const who = await holder();
    const { view } = await registered(who);
    expect(view).toMatchObject({
      registered: true,
      biometric: 'fingerprint',
      lastUsedAt: null,
    });
    expect(view.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const read = await t
      .http()
      .get(DEVICE)
      .set('Authorization', who.auth)
      .expect(200);
    expect(t.body<ApprovalDeviceView>(read).data).toEqual(view);
  });

  it('only the PIN adds a phone: no PIN is 403 pin_required, a wrong PIN uses a try, an approval is not enough', async () => {
    const who = await holder();
    const key = phoneKey();
    const none = await t
      .http()
      .put(DEVICE)
      .set('Authorization', who.auth)
      .send({ publicKey: key.publicKey, biometric: 'face' })
      .expect(403);
    expect(t.body(none).reason?.code).toBe('pin_required');
    const wrong = await register(who, key, '0000').expect(403);
    expect(t.body(wrong).reason).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });
    const other = await registered(await holder());
    const stolen = await t
      .http()
      .put(DEVICE)
      .set('Authorization', who.auth)
      .set('X-Device-Approval', `v1.${other.view.deviceId}.AAAAAAAAAA`)
      .send({ publicKey: key.publicKey, biometric: 'face' })
      .expect(403);
    expect(t.body(stolen).reason?.code).toBe('pin_required');
    const read = await t.http().get(DEVICE).set('Authorization', who.auth);
    expect(t.body<ApprovalDeviceView>(read).data!.registered).toBe(false);
  });

  it('a key that is not a P-256 public key is refused and nothing is stored', async () => {
    const who = await holder();
    for (const publicKey of ['short', 'A'.repeat(122)]) {
      const res = await t
        .http()
        .put(DEVICE)
        .set('Authorization', who.auth)
        .set('X-Transaction-Pin', '2741')
        .send({ publicKey, biometric: 'fingerprint' })
        .expect(400);
      expect(t.body(res).reason).toBeUndefined();
    }
    const bad = await t
      .http()
      .put(DEVICE)
      .set('Authorization', who.auth)
      .set('X-Transaction-Pin', '2741')
      .send({ publicKey: phoneKey().publicKey, biometric: 'iris' })
      .expect(400);
    expect(t.body(bad).reason).toBeUndefined();
    expect(
      await t.prisma.approvalDevice.findUnique({
        where: { wawuUserId: who.id },
      }),
    ).toBeNull();
  });
});

describe('approving with the registered phone', () => {
  it("the phone's signed approval passes the check every debit makes, and uses and resets no PIN try", async () => {
    const who = await holder();
    const { key } = await registered(who);
    await t.approveWithPin(who, '0000').expect(403); // one wrong PIN first
    const c = await challengeFor(who);
    const res = await approve(who, approvalFor(key, c)).expect(200);
    expect(t.body<PinStateView>(res).data!.triesLeft).toBe(4);
    const device = await t.http().get(DEVICE).set('Authorization', who.auth);
    expect(t.body<ApprovalDeviceView>(device).data!.lastUsedAt).not.toBeNull();
  });

  it('a challenge is for the registered phone, short lived and named by id', async () => {
    const who = await holder();
    const { view } = await registered(who);
    const before = Date.now();
    const c = await challengeFor(who);
    expect(c.deviceId).toBe(view.deviceId);
    expect(Buffer.from(c.challenge, 'base64url')).toHaveLength(32);
    expect(Date.parse(c.expiresAt) - before).toBeGreaterThan(115_000);
    expect(Date.parse(c.expiresAt) - before).toBeLessThan(125_000);
  });

  it('with a PIN header beside it, only the approval is checked: a wrong PIN there uses no try', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const c = await challengeFor(who);
    await approve(who, approvalFor(key, c), '0000').expect(200);
    expect(await triesLeft(who)).toBe(5);
  });
});

describe('an approval from an unregistered device is refused', () => {
  it('a phone whose key was never registered: 403 device_approval_refused, no PIN try used', async () => {
    const who = await holder();
    await registered(who);
    const c = await challengeFor(who);
    const stranger = phoneKey();
    const res = await approve(who, approvalFor(stranger, c)).expect(403);
    expect(t.body(res).reason?.code).toBe('device_approval_refused');
    expect(await triesLeft(who)).toBe(5);
  });

  it('a person with no registered phone gets no challenge', async () => {
    const who = await holder();
    const res = await t
      .http()
      .post(CHALLENGE)
      .set('Authorization', who.auth)
      .expect(403);
    expect(t.body(res).reason?.code).toBe('device_approval_refused');
  });

  it('a phone that was replaced by another no longer approves, even with a challenge issued before', async () => {
    const who = await holder();
    const first = await registered(who);
    const early = await challengeFor(who);
    const second = await registered(who);
    expect(second.view.deviceId).not.toBe(first.view.deviceId);
    await approve(who, approvalFor(first.key, early)).expect(403);
    const late = await challengeFor(who);
    expect(late.deviceId).toBe(second.view.deviceId);
    await approve(who, approvalFor(first.key, late)).expect(403);
    const c = await challengeFor(who);
    await approve(who, approvalFor(second.key, c)).expect(200);
  });

  it('turned off (DELETE), the phone approves nothing and gets no challenge', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const c = await challengeFor(who);
    const off = await t
      .http()
      .delete(DEVICE)
      .set('Authorization', who.auth)
      .expect(200);
    expect(t.body<ApprovalDeviceView>(off).data!.registered).toBe(false);
    await approve(who, approvalFor(key, c)).expect(403);
    await t.http().post(CHALLENGE).set('Authorization', who.auth).expect(403);
  });
});

describe('a user whose fingerprint fails still has all five PIN tries', () => {
  it('ten refused approvals of every kind leave every PIN try, and then the PIN still works', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const other = await holder();
    const otherKey = (await registered(other)).key;

    const used = await challengeFor(who);
    await approve(who, approvalFor(key, used)).expect(200);

    const expired = await challengeFor(who);
    await t.prisma.approvalChallenge.update({
      where: { id: expired.challengeId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const othersChallenge = await challengeFor(other);
    const forAnotherRequest = await challengeFor(who);
    const tampered = await challengeFor(who);
    const goodSig = approvalFor(key, tampered);

    const refusals = [
      'not-an-approval',
      'v1.00000000-0000-4000-8000-000000000000.AAAAAAAAAAAA',
      approvalFor(key, used), // replayed
      approvalFor(key, expired),
      approvalFor(otherKey, othersChallenge), // another person's
      approvalFor(key, othersChallenge),
      signApproval(key, forAnotherRequest, {
        method: 'POST',
        url: '/api/hub/money/transfers/bank',
        body: '{"amountKobo":100}',
      }),
      `${goodSig.slice(0, -4)}AAAA`, // a broken signature
      approvalFor(phoneKey(), await challengeFor(who)), // an unregistered phone
      '',
    ];
    for (const header of refusals) {
      const res = await approve(who, header).expect(403);
      expect(t.body(res).reason?.code).toBe('device_approval_refused');
      expect(t.body(res).message).not.toMatch(/\u2014/);
      expect(await triesLeft(who)).toBe(5);
    }
    await t.approveWithPin(who, '2741').expect(200);
    expect(await triesLeft(who)).toBe(5);
  });

  it('an approval works once: the same one five times at once passes once', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const header = approvalFor(key, await challengeFor(who));
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => approve(who, header)),
    );
    expect(answers.map((r) => r.status).sort()).toEqual([
      200, 403, 403, 403, 403,
    ]);
    expect(await triesLeft(who)).toBe(5);
  });

  it('an approval signed for one body does not pass with another', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const c = await challengeFor(who);
    const header = signApproval(key, c, {
      method: 'POST',
      url: VERIFY,
      body: '{"amountKobo":100}',
    });
    await t
      .http()
      .post(VERIFY)
      .set('Authorization', who.auth)
      .set('X-Device-Approval', header)
      .set('Content-Type', 'application/json')
      .send('{"amountKobo":900}')
      .expect(403);
    const c2 = await challengeFor(who);
    const right = signApproval(key, c2, {
      method: 'POST',
      url: VERIFY,
      body: '{"amountKobo":100}',
    });
    await t
      .http()
      .post(VERIFY)
      .set('Authorization', who.auth)
      .set('X-Device-Approval', right)
      .set('Content-Type', 'application/json')
      .send('{"amountKobo":100}')
      .expect(200);
  });
});

describe('the PIN lock and the PIN routes', () => {
  it('while the PIN is locked a real approval is 423 pin_locked (Default, agent)', async () => {
    const who = await holder();
    const { key } = await registered(who);
    for (let i = 0; i < 5; i++) await t.approveWithPin(who, '0000');
    const res = await approve(who, approvalFor(key, await challengeFor(who)));
    expect(res.status).toBe(423);
    expect(t.body(res).reason?.code).toBe('pin_locked');
  });

  it('a PIN route ignores an approval: changing the PIN still needs the PIN', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const header = signApproval(key, await challengeFor(who), {
      method: 'PUT',
      url: '/api/hub/money/pin',
      body: '{"newPin":"1111","newPinConfirmation":"1111"}',
    });
    const res = await t
      .http()
      .put('/api/hub/money/pin')
      .set('Authorization', who.auth)
      .set('X-Device-Approval', header)
      .set('Content-Type', 'application/json')
      .send('{"newPin":"1111","newPinConfirmation":"1111"}')
      .expect(403);
    expect(t.body(res).reason?.code).toBe('pin_required');
    await t.approveWithPin(who, '2741').expect(200);
  });

  it('no approval at all is 403 pin_required; a refusal is never a 401', async () => {
    const who = await holder();
    const res = await t
      .http()
      .post(VERIFY)
      .set('Authorization', who.auth)
      .expect(403);
    expect(t.body(res).reason?.code).toBe('pin_required');
    await t.http().post(VERIFY).expect(401);
  });
});

describe('the wallet gate comes first (MONEY-13)', () => {
  it('without a wallet every device route is 409 wallet_not_open, before any PIN or approval is looked at', async () => {
    const who = t.person();
    const key = phoneKey();
    const answers = [
      await t.http().get(DEVICE).set('Authorization', who.auth),
      await register(who, key),
      await t.http().delete(DEVICE).set('Authorization', who.auth),
      await t.http().post(CHALLENGE).set('Authorization', who.auth),
      await approve(who, 'v1.00000000-0000-4000-8000-000000000000.AAAAAAAAAA'),
      await t.approveWithPin(who, '2741'),
    ];
    for (const res of answers) {
      expect(res.status).toBe(409);
      expect(t.body(res).reason?.code).toBe('wallet_not_open');
    }
  });
});

describe('nothing secret is stored or logged', () => {
  it('stores the public key only, and no approval header reaches a log', async () => {
    const who = await holder();
    const { key } = await registered(who);
    const header = approvalFor(key, await challengeFor(who));
    await approve(who, header).expect(200);
    const row = await t.prisma.approvalDevice.findUniqueOrThrow({
      where: { wawuUserId: who.id },
    });
    expect(row.publicKey).toBe(key.publicKey);
    const signature = header.split('.')[2];
    expect(t.log.lines.join('\n')).not.toContain(signature);
    const pem = key.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64url');
    expect(JSON.stringify(row)).not.toContain(pem.slice(-40));
  });
});
