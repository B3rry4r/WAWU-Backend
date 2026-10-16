import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminOpsAction,
  AdminOpsResource,
} from '../../../generated/prisma/enums';
import {
  type AdminActor,
  AdminOpsAuditService,
} from '../../common/audit/admin-ops-audit.service';
import { WalletOpeningService } from '../../money/opening/wallet-opening.service';

/** What releasing one person's hold answered. Never a BVN, a hash or a name. */
export interface IdentityHoldReleaseView {
  wawuUserId: string;
  /** `released`: the hold was let go now. `already_released`: nothing to do. */
  outcome: 'released' | 'already_released';
  /** The opening's state now: `expired` after a release. */
  state: 'expired' | 'unchanged';
}

/**
 * Support lets go of one person's hold on a BVN at once (NUV-02 round 3,
 * N3). "Contact support" is the sentence a blocked person is told; this is
 * what support does about it: the holder's Nuvion opening is marked expired
 * (as an idle one is), their BVN is let go, they are told once, and a person
 * who was blocked may open with it. Nothing is sent to Nuvion or deleted
 * there.
 *
 * The route names the HOLDER's account, never a BVN: it takes no number and
 * returns none. Every release is audited (AdminOpsAudit: who, which account,
 * the state before) and logged by the account id and the admin id only.
 */
@Injectable()
export class AdminIdentityHoldsService {
  private readonly logger = new Logger(AdminIdentityHoldsService.name);

  constructor(
    private readonly opening: WalletOpeningService,
    private readonly audit: AdminOpsAuditService,
  ) {}

  async release(
    actor: AdminActor,
    wawuUserId: string,
  ): Promise<IdentityHoldReleaseView> {
    const done = await this.opening.releaseIdentityHold(wawuUserId);
    switch (done.outcome) {
      case 'no_opening':
        throw new NotFoundException(
          'That account has no wallet opening with a hold to release.',
        );
      case 'has_wallet':
        throw new ConflictException(
          'That account has a wallet; it holds no opening to release.',
        );
      case 'in_review':
        throw new ConflictException(
          'The identity review of that account is still going on; wait for its decision.',
        );
      case 'already_released':
      case 'not_held':
        return {
          wawuUserId,
          outcome: 'already_released',
          state: 'unchanged',
        };
      case 'released':
        break;
    }
    this.logger.log(
      `identity hold released by support: account ${wawuUserId}, admin ${actor.id}`,
    );
    await this.audit.record(actor, {
      resource: AdminOpsResource.wallet_identity_hold,
      resourceId: wawuUserId,
      subjectWawuId: wawuUserId,
      action: AdminOpsAction.wallet_identity_hold_released,
      detail: { stateBefore: done.before, stateAfter: 'expired' },
    });
    return { wawuUserId, outcome: 'released', state: 'expired' };
  }
}
