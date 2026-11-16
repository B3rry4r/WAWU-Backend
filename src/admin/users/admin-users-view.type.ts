import type { AccountType } from '../../../generated/prisma/enums';

/**
 * One account on the dashboard's Users page (R-142). Name, email and phone
 * come from WAWU ID for the page shown and are stored nowhere; they are null
 * for a person WAWU ID has no row for, and for everyone when WAWU ID cannot
 * be reached (the list then says `contactUnavailable`).
 */
export interface AdminUserListItemView {
  wawuId: string;
  firstName: string | null;
  lastName: string | null;
  handle: string | null;
  email: string | null;
  phone: string | null;
  /** ISO 3166-1 alpha-2 from the Hub's place for the person, or null (no country yet). */
  countryCode: string | null;
  countryName: string | null;
  /** `profile` (they chose it), `wawu_id`, `phone`, or null with no country. */
  countrySource: 'profile' | 'wawu_id' | 'phone' | null;
  accountType: AccountType;
  /** `UserProfile.createdAt`: when the Hub account was made. */
  joinedAt: Date;
  /** Holds a verification tick now (creator or professional, not lapsed). */
  tickHeld: boolean;
  /** Has a wallet row at the provider this server runs. */
  walletOpened: boolean;
  /** A suspension is in force (an `UserSuspension` row not yet lifted). */
  suspended: boolean;
}

export interface AdminUserListPage {
  items: AdminUserListItemView[];
  currentPage: number;
  perPage: number;
  total: number;
  /** True when names and contacts could not be loaded from WAWU ID. */
  contactUnavailable: boolean;
  /** True when a search's WAWU ID matches were cut at the 500 newest, so `total` is not the whole answer. */
  truncated: boolean;
}

export interface AdminUserCountsView {
  total: number;
  creators: number;
  /** Accounts made today, the Lagos day. */
  joinedToday: number;
  /** Accounts with no country yet (the dashboard's "no country yet"). */
  noCountry: number;
}
