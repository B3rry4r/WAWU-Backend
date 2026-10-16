import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DELETION_BLOCKERS,
  type DeletionBlocker,
} from '../account-deletion-money.service';

/** `POST /account/cancel-deletion` (SETTINGS-06; WAWU ID calls it on sign-in, SETTINGS-08). */
export class CancelDeletionResponseDto {
  /** False: no deletion was waiting, and nothing was changed. */
  cancelled!: boolean;
  /** True when the wallet was frozen for the deletion and is let go again. */
  walletUnfrozen!: boolean;
  /** How many content pieces the deletion had hidden and are back. */
  contentRestored!: number;
}

/**
 * Why `DELETE /account` answered 409 (Z6): the one error shape of
 * docs/contract/CONVENTIONS.md section 3, with `reason.code`
 * `account_deletion_blocked`.
 */
export class AccountDeletionBlockedReason {
  @ApiProperty({ enum: ['account_deletion_blocked'] })
  code!: 'account_deletion_blocked';

  /** A sentence the app may show as it is. */
  message!: string;

  /** What to settle first. The app leads with `wallet_balance` (Withdraw). */
  @ApiProperty({ enum: DELETION_BLOCKERS, isArray: true })
  blockers!: DeletionBlocker[];

  /** The wallet provider's balance in kobo, when the person has a wallet. */
  @ApiPropertyOptional({ type: 'integer' })
  balanceKobo?: number;

  /** Holds open for or against the person (paid DMs, tickets, bills). */
  @ApiProperty({ type: 'integer' })
  openHolds!: number;

  /** Sales whose share has not reached the person's wallet yet. */
  @ApiProperty({ type: 'integer' })
  waitingEarnings!: number;
}

export class AccountDeletionBlockedBody {
  statusCode!: number;
  message!: string;
  @ApiProperty({ nullable: true, type: 'null' })
  data!: null;
  reason!: AccountDeletionBlockedReason;
}
