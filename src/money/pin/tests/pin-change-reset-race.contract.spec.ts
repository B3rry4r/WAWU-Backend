import * as argon2 from 'argon2';
import {
  Money14App,
  type Person,
} from '../../../../test/money/pin-approval-harness';

/**
 * A PIN change and a reset's confirm for one person at the same moment (task
 * WALLET-06 round 2, D2). `PUT /money/pin` took the PIN row and then the
 * person's open reset rows (BACKEND_GAPS G-50) while `POST /money/pin/reset/
 * confirm` took the reset row and then the PIN row, so one of the two could be
 * refused by the database as a deadlock and answer 500: 9 of 80 pairs in the
 * verifier's run. Both now take the per-person lock `start()` has always taken,
 * first, so they run one after the other.
 *
 * 80 pairs, each of one change and one confirm sent at once for one person,
 * one pair at a time. No answer is a 500, and every pair ends in the same
 * place whichever went first: no reset left open, and exactly one valid PIN
 * (the confirm's when the change was beaten to the PIN and refused, the
 * change's otherwise: when the change ran first the confirm's code is dead).
 *
 * The people are made with their rows written directly (a wallet, a PIN, a
 * reset with a known code), because what is under test is the two routes, not
 * the text or the BVN check; the PIN and the code are hashed once and shared.
 */

jest.setTimeout(900_000);

const PAIRS = Number(process.env.PIN_RACE_PAIRS ?? 80);
/**
 * One pair at a time, as the verifier ran them. Eight at once saturate the four threads argon2 hashes on, which spreads
 * the two requests of a pair apart; alone, the pair's two requests reach their transactions within a few
 * milliseconds of each other, which is when the deadlock happened (9 of 80 pairs). The mutant that took the lock out
 * of `change` survived a run of eight at once.
 */
const AT_A_TIME = 1;

const t = new Money14App({});
const [OLD_PIN, CHOSEN, FROM_CODE] = t.reservePins(3);
const CODE = '483920';
let pinHash = '';
let codeHash = '';

beforeAll(async () => {
  await t.start();
  pinHash = await argon2.hash(OLD_PIN, { type: argon2.argon2id });
  codeHash = await argon2.hash(CODE, { type: argon2.argon2id });
});
afterAll(() => t.stop());

type Pair = { who: Person; resetId: string };

async function pairReady(): Promise<Pair> {
  const who = t.person();
  await t.openWallet(who);
  await t.prisma.transactionPin.create({
    data: { wawuUserId: who.id, pinHash },
  });
  const reset = await t.prisma.transactionPinReset.create({
    data: {
      wawuUserId: who.id,
      phone: who.phone,
      codeHash,
      sendState: 'sent',
      expiresAt: new Date(Date.now() + 10 * 60_000),
      resendAvailableAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  return { who, resetId: reset.id };
}

describe('a PIN change and a reset confirm at the same moment', () => {
  it(`${PAIRS} pairs: no answer is a 500, no reset is left open, and one PIN is valid`, async () => {
    const tally: Record<string, number> = {};
    const bad: string[] = [];
    for (let at = 0; at < PAIRS; at += AT_A_TIME) {
      const batch: Pair[] = [];
      for (let i = 0; i < AT_A_TIME && at + i < PAIRS; i += 1) {
        batch.push(await pairReady());
      }
      await Promise.all(
        batch.map(async (p) => {
          const [changed, confirmed] = await Promise.all([
            t
              .http()
              .put('/api/hub/money/pin')
              .set('Authorization', p.who.auth)
              .set('X-Transaction-Pin', OLD_PIN)
              .send({ newPin: CHOSEN, newPinConfirmation: CHOSEN }),
            t
              .http()
              .post('/api/hub/money/pin/reset/confirm')
              .set('Authorization', p.who.auth)
              .send({
                resetId: p.resetId,
                code: CODE,
                newPin: FROM_CODE,
                newPinConfirmation: FROM_CODE,
              }),
          ]);
          const key = `change=${changed.status} confirm=${confirmed.status}`;
          tally[key] = (tally[key] ?? 0) + 1;
          if (changed.status >= 500 || confirmed.status >= 500) {
            bad.push(`${key}: ${changed.text} | ${confirmed.text}`);
          }
          const open = await t.prisma.transactionPinReset.count({
            where: { wawuUserId: p.who.id, usedAt: null, supersededAt: null },
          });
          if (open !== 0) bad.push(`${key}: ${open} reset(s) left open`);
          // Exactly one of the two new PINs approves, whichever went first:
          // the change ran first (the code is dead, the chosen PIN stays); or
          // the confirm ran first and the change, if it got the PIN row
          // first, replaced it, and if not was refused for the PIN it knew.
          const chosenOk = (await t.approveWithPin(p.who, CHOSEN)).status;
          const codeOk = (await t.approveWithPin(p.who, FROM_CODE)).status;
          if ((chosenOk === 200) === (codeOk === 200)) {
            bad.push(`${key}: chosen=${chosenOk} fromCode=${codeOk}`);
          }
        }),
      );
    }
    const deadlocks = t.log.lines.filter((l) =>
      /deadlock|P2034|40P01|write conflict/i.test(l),
    );
    // What the server said about each 500, so a failure names its cause.
    const errors = t.log.lines.filter((l) => /^error /.test(l)).slice(0, 3);
    expect([...bad.slice(0, 5), ...errors.map((e) => e.slice(0, 600))]).toEqual(
      [],
    );
    expect(bad).toEqual([]);
    expect(deadlocks).toEqual([]);
    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(PAIRS);
  });
});
