import {
  Money14App,
  type Person,
} from '../../../test/money/pin-approval-harness';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import type { PinResetView, PinStateView } from '../../money/money-view.type';

/**
 * NUV-01: under WALLET_PROVIDER=nuvion a person who resets their PIN gets
 * the code by email, and nothing is sent by SMS (R-39). Real database, real
 * RS256 tokens checked against a local WAWU ID (test/nuvion/), the Fintava
 * stand-in still mounted (its SMS route would record any text) and the
 * Nuvion adapter booted with its settings, never reached (no Nuvion call is
 * made by a PIN reset; every connection but loopback is refused).
 *
 * The code goes to WAWU ID's internal route
 * (`POST /internal/users/:userId/pin-reset-code`, BACKEND_GAPS G-400), which
 * owns the address and the wording; the Hub never holds an address.
 */

jest.setTimeout(60_000);

const SERVICE_KEY = 'nuv01-internal-service-key-0123456789';
const RESET = '/api/hub/money/pin/reset';
const CONFIRM = '/api/hub/money/pin/reset/confirm';

const wawuId = new WawuIdDouble();
let t: Money14App;
let guard: OutboundGuard;

beforeAll(async () => {
  guard = guardOutbound();
  await wawuId.start();
  t = new Money14App({
    WALLET_PROVIDER: 'nuvion',
    NUVION_BASE_URL: 'https://api.nuvion.dev',
    NUVION_API_KEY: 'nv_test_sk_NUV01pinresetKEY0000000000000',
    NUVION_WEBHOOK_SECRET: 'whsec_nuv01_pin_0123456789',
    NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
    WAWU_ID_JWKS_URL: wawuId.jwksUrl,
    WAWU_ID_BASE_URL: wawuId.baseUrl,
    WAWU_ID_INTERNAL_SERVICE_KEY: SERVICE_KEY,
  });
  await t.start();
});
afterAll(async () => {
  await t.stop();
  await wawuId.stop();
  guard.restore();
});
const allCodes: string[] = [];
beforeEach(() => {
  t.installDefaults();
  wawuId.emailed.length = 0;
  wawuId.answer = { status: 200 };
});
afterEach(() => {
  allCodes.push(...wawuId.emailed.map((m) => String(m.body.code)));
});

const pins = () => t.reservePins(3);

/** A wallet holder at Nuvion with a PIN, and no BVN-proved phone (Nuvion runs no BVN lookup). */
async function holder(pin: string): Promise<Person> {
  const who = t.person();
  await t.openWallet(who);
  await t.prisma.fintavaWallet.update({
    where: { wawuUserId: who.id },
    data: { provider: 'nuvion' },
  });
  await t.setPin(who, pin);
  return who;
}

describe('NUV-01: under nuvion the PIN reset code goes by email, never by SMS', () => {
  it('the code is emailed through WAWU ID to the account, nothing is texted, and the code sets a new PIN', async () => {
    const [oldPin, newPin] = pins();
    const who = await holder(oldPin);
    const res = await t
      .http()
      .post(RESET)
      .set('Authorization', who.auth)
      .expect(201);
    const reset = t.body<PinResetView>(res).data!;
    // The token's own address, masked: the first letter and the domain.
    expect(reset.sentTo).toBe('m***@example.com');

    expect(wawuId.emailed).toHaveLength(1);
    const mail = wawuId.emailed[0];
    expect(mail.userId).toBe(who.id);
    expect(mail.serviceKey).toBe(SERVICE_KEY);
    expect(mail.body.expiresInMinutes).toBe(5);
    expect(mail.body.code).toMatch(/^\d{6}$/);
    // Nothing by SMS: the Fintava stand-in got no text.
    expect(t.texts()).toEqual([]);
    expect(t.double.seen).toEqual([]);

    const confirmed = await t
      .http()
      .post(CONFIRM)
      .set('Authorization', who.auth)
      .send({
        resetId: reset.resetId,
        code: mail.body.code,
        newPin,
        newPinConfirmation: newPin,
      })
      .expect(200);
    expect(t.body<PinStateView>(confirmed).data).toMatchObject({
      isSet: true,
      triesLeft: 5,
    });
    await t.approveWithPin(who, newPin).expect(200);
    await t.approveWithPin(who, oldPin).expect(403);
  });

  it('asked again before Resend opens: the same reset, no second email', async () => {
    const [pin] = pins();
    const who = await holder(pin);
    const first = t.body<PinResetView>(
      await t.http().post(RESET).set('Authorization', who.auth).expect(201),
    ).data!;
    const again = t.body<PinResetView>(
      await t.http().post(RESET).set('Authorization', who.auth).expect(201),
    ).data!;
    expect(again.resetId).toBe(first.resetId);
    expect(wawuId.emailed).toHaveLength(1);
  });

  it('WAWU ID refuses (its route missing: 404): not sent, 503, and that code never works', async () => {
    const [pin, newPin] = pins();
    const who = await holder(pin);
    wawuId.answer = { status: 404 };
    const res = await t
      .http()
      .post(RESET)
      .set('Authorization', who.auth)
      .expect(503);
    expect(t.body(res).reason).toMatchObject({ code: 'provider_unreachable' });
    expect(t.body(res).message).toBe(
      'We could not send the code right now. Try again in a moment.',
    );
    const row = await t.prisma.transactionPinReset.findFirstOrThrow({
      where: { wawuUserId: who.id },
    });
    expect(row.sendState).toBe('failed');
    const code = String(wawuId.emailed[0].body.code);
    await t
      .http()
      .post(CONFIRM)
      .set('Authorization', who.auth)
      .send({ resetId: row.id, code, newPin, newPinConfirmation: newPin })
      .expect(400);
    expect(t.texts()).toEqual([]);
  });

  it('WAWU ID fails while sending (5xx): it may have arrived, so the code stays usable and nothing is sent again', async () => {
    const [pin, newPin] = pins();
    const who = await holder(pin);
    wawuId.answer = { status: 500 };
    const res = await t
      .http()
      .post(RESET)
      .set('Authorization', who.auth)
      .expect(503);
    expect(t.body(res).message).toContain(
      'We could not confirm the code was sent',
    );
    const row = await t.prisma.transactionPinReset.findFirstOrThrow({
      where: { wawuUserId: who.id },
    });
    expect(row.sendState).toBe('unknown');
    wawuId.answer = { status: 200 };
    await t.http().post(RESET).set('Authorization', who.auth).expect(201);
    expect(wawuId.emailed).toHaveLength(1);
    await t
      .http()
      .post(CONFIRM)
      .set('Authorization', who.auth)
      .send({
        resetId: row.id,
        code: String(wawuId.emailed[0].body.code),
        newPin,
        newPinConfirmation: newPin,
      })
      .expect(200);
  });

  it('no log line or answer holds a code; nothing left this machine', () => {
    expect(allCodes.length).toBeGreaterThanOrEqual(4);
    const all = [...t.log.lines, ...t.answered].join('\n');
    for (const code of allCodes) expect(all).not.toContain(code);
    expect(all).not.toContain(SERVICE_KEY);
    expect(guard.violations).toEqual([]);
  });
});
