import type { HoldStatus } from '../../money/money-view.type';
import type { EnrolmentStatus } from './school-enrolment-rules';

/**
 * What came back to the student when the class filled between their payment
 * and their place (the fee goes back through the hold, R-19). `returned` is
 * true once the wallet provider confirmed the move into the wallet; until then
 * the money is on its way (`returnedKobo` null) and nothing is owed again.
 */
export interface EnrolmentReturnView {
  holdStatus: HoldStatus;
  returned: boolean;
  /** What reached the wallet; null until `returned`. */
  returnedKobo: number | null;
}

/**
 * One enrolment as it stands now: SC4's held place, SC7's receipt. The course,
 * school and class are as they were when the student enrolled, and the amounts
 * are what was quoted and charged, so a school editing a course later changes
 * no receipt.
 */
export interface SchoolEnrolmentView {
  id: string;
  /**
   * `reserved`: the place is held and waiting for its payment until
   * `reservedUntil`. `enrolled`: paid. `released`: the place went back to the
   * class (it ran out, or the student chose another class). `refunded`: paid,
   * but the class filled in the gap and the fee is going back to the wallet.
   */
  status: EnrolmentStatus;
  /** SC7's reference ("WAW-SC4K-81PQ"). */
  reference: string;
  course: { id: string; title: string };
  school: { id: string; name: string };
  intake: {
    id: string;
    /** YYYY-MM-DD, a calendar date. */
    startDate: string;
    schedule: string;
    location: string | null;
  };
  /** The course fee that was quoted. */
  priceKobo: number;
  /** The wallet payment that paid it; null until it is paid. */
  paymentId: string | null;
  /** The wallet provider's charge actually taken on top of the fee; null until paid. */
  providerFeeKobo: number | null;
  /** The fee and the charge, what the wallet was actually debited; null until paid. */
  totalKobo: number | null;
  /** While `reserved`: when the place goes back to the class if it is not paid. */
  reservedUntil: string | null;
  createdAt: string;
  enrolledAt: string | null;
  returned: EnrolmentReturnView | null;
}
