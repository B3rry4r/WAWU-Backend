/**
 * What the send-abroad routes answer (task NUV-11, R-84). Every amount is an
 * integer in a currency's smallest unit in a field ending `Minor`, always
 * beside the currency it is in (docs/contract/CONVENTIONS.md section 1a).
 * WAWU's own fee is naira only (R-10), in kobo.
 */

export type AbroadMethod = 'bank' | 'mobile_money';

export type AbroadFieldKindView =
  'text' | 'digits' | 'bank' | 'phone' | 'email' | 'choice';

export interface AbroadFieldOptionView {
  value: string;
  label: string;
}

/** One thing the recipient form asks, for a country and rail. */
export interface AbroadFieldView {
  key: string;
  label: string;
  kind: AbroadFieldKindView;
  /** A pattern the value must match, or null. */
  pattern: string | null;
  hint: string | null;
  /** The choices of a `choice` field, else null. */
  options: AbroadFieldOptionView[] | null;
}

/**
 * One way to arrive. A rail Nuvion has one way for has one entry whose `id`
 * is null; the app asks which only when there are several.
 */
export interface AbroadSchemeView {
  id: string | null;
  label: string;
  /** How long Nuvion's table says it takes, in words ("Same day"). */
  speed: string;
  /** The fields to ask for this scheme, in the order drawn. */
  fields: AbroadFieldView[];
}

export interface AbroadRailView {
  method: AbroadMethod;
  label: string;
  /** The `bank` field is a picker over `GET /money/abroad/banks/{country}`. */
  directory: boolean;
  schemes: AbroadSchemeView[];
  /** The least and most the rail takes, in the destination currency's smallest unit; null = none stated. */
  minReceiveMinor: number | null;
  maxReceiveMinor: number | null;
}

export interface AbroadCountryView {
  /** ISO 3166-1 alpha-2. */
  country: string;
  name: string;
  /** The currency the recipient is paid in. */
  currency: string;
  decimals: number;
  /** False when Nuvion does not pay here yet or an admin switched it off. */
  available: boolean;
  /** Why, in plain words, when `available` is false; else null. */
  unavailableNote: string | null;
  rails: AbroadRailView[];
}

export interface AbroadCorridorsView {
  /** The product switch. When false the app draws none of it (R-47). */
  enabled: boolean;
  /** The smallest amount the recipient can be sent, in their currency's smallest unit (Nuvion: 100). */
  minReceiveMinor: number;
  /** WAWU's fee for a send, in kobo, taken from the naira wallet (R-10). 0 until the owner names it. */
  wawuFeeKobo: number;
  countries: AbroadCountryView[];
}

export interface AbroadBankView {
  code: string;
  name: string;
  swiftBic: string | null;
}

export interface AbroadBankListView {
  country: string;
  banks: AbroadBankView[];
}

/** An account the person can send from, with the provider's balance read now. */
export interface AbroadSourceView {
  currency: string;
  name: string;
  decimals: number;
  /** What can be spent, read from the provider on this request; null if it could not be asked. */
  availableMinor: number | null;
}

export interface AbroadSourcesView {
  sources: AbroadSourceView[];
}

export interface AbroadRecipientView {
  id: string;
  country: string;
  countryName: string;
  currency: string;
  method: AbroadMethod;
  scheme: string | null;
  holderName: string;
  bankName: string | null;
  /** Last 4 characters of the account, wallet number or IBAN; the rest is never kept here. */
  last4: string | null;
  /** One line for a list ("Ghana, MTN mobile money, ending 4567"). */
  summary: string;
  createdAt: string;
}

export interface AbroadRecipientListView {
  items: AbroadRecipientView[];
}

/**
 * What a send would cost and deliver, held until `expiresAt`. When the two
 * currencies differ, `rate` and the hold are Nuvion's; when they are the
 * same there is no conversion and the hold is WAWU's own.
 */
export interface AbroadQuoteView {
  id: string;
  recipientId: string;
  fromCurrency: string;
  toCurrency: string;
  fromDecimals: number;
  toDecimals: number;
  /** What leaves the account. */
  amountFromMinor: number;
  /** What the recipient gets. */
  amountToMinor: number;
  converted: boolean;
  /** Units of `toCurrency` per unit of `fromCurrency`, as text; null when not converted. */
  rate: string | null;
  /** Nuvion names its fee only when it takes the send (null here); the receipt carries it. */
  providerFeeMinor: number | null;
  /** WAWU's fee in kobo, taken from the naira wallet. */
  wawuFeeKobo: number;
  /** How long it takes, from the rail. */
  speed: string;
  expiresAt: string;
  validForSeconds: number;
}

export type AbroadSendStatus =
  | 'sending'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'reversed'
  | 'cancelled'
  | 'needs_review';

export interface AbroadSendView {
  id: string;
  status: AbroadSendStatus;
  recipient: AbroadRecipientView;
  fromCurrency: string;
  toCurrency: string;
  fromDecimals: number;
  toDecimals: number;
  amountFromMinor: number;
  amountToMinor: number;
  rate: string | null;
  /** What Nuvion charged, once it says; null until then. */
  providerFeeMinor: number | null;
  wawuFeeKobo: number;
  narration: string | null;
  /** In plain words when the send failed, was reversed or was cancelled; else null. */
  failureReason: string | null;
  speed: string;
  createdAt: string;
  completedAt: string | null;
}

export interface AbroadSendPage {
  items: AbroadSendView[];
  nextCursor: string | null;
}

export interface AdminAbroadSendView {
  id: string;
  wawuUserId: string;
  status: AbroadSendStatus;
  recipientName: string;
  country: string;
  fromCurrency: string;
  toCurrency: string;
  amountFromMinor: number;
  amountToMinor: number;
  providerFeeMinor: number | null;
  wawuFeeKobo: number;
  /** WAWU's fee could not be taken from the naira wallet yet; finance looks at these. */
  wawuFeeOwed: boolean;
  /** Our reference at the provider. */
  reference: string;
  /** The provider's own word for its state, as last read; null before it answered. */
  providerStatus: string | null;
  failureReason: string | null;
  /** The person is frozen: no new send leaves. */
  personFrozen: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminAbroadSendPage {
  items: AdminAbroadSendView[];
  nextCursor: string | null;
}

export interface AdminAbroadFreezeView {
  wawuUserId: string;
  frozen: boolean;
  reason: string | null;
  at: string | null;
}

export interface AdminAbroadCancelView {
  id: string;
  status: AbroadSendStatus;
}
