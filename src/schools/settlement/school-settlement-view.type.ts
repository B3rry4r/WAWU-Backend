import type {
  SettlementAction,
  SettlementStatus,
  SettlementWaiting,
} from './school-settlement-rules';

/** The school's payee as the dashboard reads it. The account number is shown as its last four digits. */
export interface SchoolPayeeView {
  schoolId: string;
  bankCode: string;
  bankName: string;
  accountNumberLast4: string;
  /** The holder's name as the bank gave it. */
  accountName: string;
  verifiedAt: string;
}

/** One enrolment's fee settlement as the dashboard reads it. All amounts are integer kobo. */
export interface SchoolSettlementView {
  id: string;
  enrolmentId: string;
  /** What the student quotes (WAW-XXXX-XXXX). */
  reference: string;
  schoolId: string;
  schoolName: string;
  courseTitle: string;
  action: SettlementAction;
  status: SettlementStatus;
  priceKobo: number;
  /** The school's 85% of the fee (R-12). */
  schoolShareKobo: number;
  /** WAWU's 15% of the fee. */
  wawuShareKobo: number;
  /** What the provider charged WAWU on the payout, from WAWU's share (R-31); null until known. */
  providerFeeKobo: number | null;
  waiting: SettlementWaiting | null;
  reviewNote: string | null;
  decidedAt: string;
  paidAt: string | null;
  refundedAt: string | null;
}

/** A page of settlements, newest first. */
export interface SchoolSettlementPage {
  items: SchoolSettlementView[];
}

/** What cancelling a class did to the fees paid for it. */
export interface CancelIntakeView {
  intakeId: string;
  cancelledAt: string;
  /** Paid enrolments whose fee is going back to the student's wallet. */
  refunding: number;
  /** Paid enrolments whose fee had already gone to the school: not refunded from here. */
  alreadyPaidOut: number;
  /** Unpaid places given back. */
  placesReleased: number;
}
