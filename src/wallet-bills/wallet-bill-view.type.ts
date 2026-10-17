import type { BillCategory } from '../money/dto/money-enums';
import type {
  FeeQuotePartView,
  HoldStatus,
  PaymentQuoteView,
} from '../money/money-view.type';
import type { BillProgress } from './wallet-bill-rules';

/**
 * What came back to the payer when the biller failed (S12). `returned` is true
 * once Fintava confirmed the move into the wallet; until then the money is
 * on its way (`returnedKobo` null) and nothing is owed again.
 */
export interface BillReturnView {
  holdStatus: HoldStatus;
  returned: boolean;
  /** What reached the wallet; null until `returned`. */
  returnedKobo: number | null;
}

/**
 * A bill paid from the wallet (BILLS-04) as it stands now: S5's review before
 * payment, S7's token after, S12's failure.
 */
export interface WalletBillView {
  id: string;
  category: BillCategory;
  /** The disco code, network or cable provider, as the catalogue names it. */
  billerCode: string;
  /** What a person reads for the biller ("Ikeja Electric"). */
  title: string;
  /** prepaid or postpaid; electricity only. */
  planType: 'prepaid' | 'postpaid' | null;
  /** A data bundle's or cable plan's code, and its name. */
  productCode: string | null;
  productLabel: string | null;
  /** The meter, phone or smartcard number the bill is for. */
  accountNumber: string | null;
  /** The name Fintava holds for the meter. */
  accountName: string | null;
  /** The bill's own amount: what the biller gets. */
  amountKobo: number;
  /** Fintava's charge on the bill (R-31). */
  billChargeKobo: number;
  /** WAWU's fee on the bill (R-10). */
  serviceFeeKobo: number;
  /** The reference a person quotes (WAW-BIL-...). */
  reference: string;
  status: BillProgress;
  /** The wallet payment that paid it; null before it is paid. */
  paymentId: string | null;
  /** Fintava's balance-transfer charge on the payment, and what left the wallet in all; null before it is paid. */
  transferFeeKobo: number | null;
  totalKobo: number | null;
  /** The electricity token, once the biller delivers it. */
  token: string | null;
  /** The units bought ("45.2"), when Fintava said. */
  units: string | null;
  /** On `failed`, why, in words a person reads. */
  failureReason: string | null;
  /** On `failed`, the money coming back. */
  returned: BillReturnView | null;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
}

/** S5: the bill priced, what it costs line by line, and the wallet payment's own quote. */
export interface WalletBillQuoteView {
  bill: WalletBillView;
  /** The bill charge, WAWU's fee and the balance-transfer charge, in the order the review lists them. */
  parts: FeeQuotePartView[];
  /** The payment quote `POST /bills/wallet/pay` repeats: its `totalKobo` and `quoteToken`. */
  payment: PaymentQuoteView;
}
