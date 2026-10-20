import { Module } from '@nestjs/common';
import { CommunityPassAccess } from './community-pass-access.service';

/**
 * The read side of a room's pass (task INBOX-24), apart from the wallet
 * routes in CommunityPassModule, so the modules that gate a room can import it
 * without MoneyModule and the wallet provider's settings.
 */
@Module({
  providers: [CommunityPassAccess],
  exports: [CommunityPassAccess],
})
export class CommunityPassAccessModule {}
