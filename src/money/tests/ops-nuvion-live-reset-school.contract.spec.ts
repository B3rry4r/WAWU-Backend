import {
  bootSchoolNuvion,
  type SchoolNuvion,
} from '../../../test/schools/school-nuvion-harness';
import { runUnowned } from '../../../scripts/ops/nuvion-live-reset';
import { lagosToday } from '../../schools/enrolment/school-enrolment-rules';
import { SchoolPayeeService } from '../../schools/settlement/school-payee.service';
import { SchoolSettlementService } from '../../schools/settlement/school-settlement.service';

/**
 * NUV-LIVE finding 1: SchoolPayee.counterpartyId and paymentDetailId are Nuvion TEST ids, cached on a row that
 * belongs to a school. The first school payout after the keys change passes them to bankTransfer from WAWU's live
 * merchant account. The reset clears both. Here a payout is made BEFORE the clear (the stand-in, recording every call,
 * is sent the test ids: the probe works) and another AFTER (it is sent none, so live Nuvion makes a fresh
 * counterparty and the payee row caches the new ones). The bank, account and name never change.
 */
jest.setTimeout(180_000);
const PRICE = 15_000_000;
const HOLDER = 'GREENFIELD TECH ACADEMY LTD';
const TEST_CP = 'cp_TESTSYSTEM_01';
const TEST_PD = 'pd_TESTSYSTEM_01';

describe('a school payout after the reset makes a fresh counterparty (NUV-LIVE)', () => {
  let h: SchoolNuvion;
  let settlements: SchoolSettlementService;
  let payees: SchoolPayeeService;
  let clock = Date.now();
  let seq = 0;
  const later = (ms = 10 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  beforeAll(async () => {
    h = await bootSchoolNuvion('nlr1');
    settlements = h.app.get(SchoolSettlementService);
    payees = h.app.get(SchoolPayeeService);
    h.nuvion.bankMode = 'pending';
    h.nuvion.mode = 'pending';
  });
  afterAll(async () => {
    if (h) await h.close();
  });

  /** A class that starts today, a school bank account the bank confirms, and the test ids on its payee row. */
  async function school() {
    const c = await h.seed({
      priceKobo: PRICE,
      intakes: [{ capacity: 10, startDate: lagosToday(new Date()) }],
    });
    seq += 1;
    const account = `01${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
    h.nuvion.bankDirectory.set(`058:${account}`, HOLDER);
    await payees.set(
      c.schoolId,
      { bankCode: '058', accountNumber: account },
      null,
    );
    await h.prisma.schoolPayee.update({
      where: { schoolId: c.schoolId },
      data: { counterpartyId: TEST_CP, paymentDetailId: TEST_PD },
    });
    return { ...c, account };
  }

  async function payoutPayeeSeen(c: { intakeIds: string[]; account: string }) {
    const student = await h.person(20_000_000);
    const before = h.nuvion.calls.length;
    await h.enrolAndPay(student, c.intakeIds[0]);
    await settlements.run(later());
    const sends = h.nuvion.calls
      .slice(before)
      .filter((x) => x.method === 'bankTransfer')
      .map((x) => x.args as { accountNumber: string; payee?: unknown });
    return sends.filter((x) => x.accountNumber === c.account);
  }

  it('sends the test ids before the clear and none after, and the payee row caches the fresh ones', async () => {
    const before = await school();
    const seenBefore = await payoutPayeeSeen(before);
    // The probe works: with the ids on the row, the stand-in is sent them.
    expect(seenBefore).toHaveLength(1);
    expect(JSON.stringify(seenBefore[0].payee)).toContain(TEST_CP);

    const after = await school();
    const cleared = await runUnowned(h.prisma, [], ['school_payee_ids']);
    expect(cleared.school_payee_ids).toBeGreaterThanOrEqual(1);
    const row = await h.prisma.schoolPayee.findUniqueOrThrow({
      where: { schoolId: after.schoolId },
    });
    expect([row.counterpartyId, row.paymentDetailId]).toEqual([null, null]);
    expect([row.bankCode, row.accountNumber, row.accountName]).toEqual([
      '058',
      after.account,
      HOLDER,
    ]);
    const seenAfter = await payoutPayeeSeen(after);
    expect(seenAfter).toHaveLength(1);
    const text = JSON.stringify(seenAfter[0].payee ?? null);
    expect(text).not.toContain(TEST_CP);
    expect(text).not.toContain(TEST_PD);
    const settled = await h.prisma.schoolSettlement.findFirstOrThrow({
      where: { schoolId: after.schoolId },
    });
    expect(settled.counterpartyId ?? null).not.toBe(TEST_CP);
    expect(settled.paymentDetailId ?? null).not.toBe(TEST_PD);
  });
});
