import { Module } from '@nestjs/common';
import { CommunityPassAccess } from './community-pass-access.service';
import { CommunityPassRemoval } from './community-pass-removal.service';

/**
 * The read side of a room's pass (task INBOX-24), apart from the wallet
 * routes in CommunityPassModule, so the modules that gate a room can import it
 * without MoneyModule and the wallet provider's settings. INBOX-25 adds the
 * database half of a removal's refund (`CommunityPassRemoval`), which reaches
 * nothing but the database for the same reason.
 */
@Module({
  providers: [CommunityPassAccess, CommunityPassRemoval],
  exports: [CommunityPassAccess, CommunityPassRemoval],
})
export class CommunityPassAccessModule {}
