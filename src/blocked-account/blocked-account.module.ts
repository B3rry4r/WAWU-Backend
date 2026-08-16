import { Module } from '@nestjs/common';
import { BlockedAccountController } from './blocked-account.controller';
import { BlockedAccountService } from './blocked-account.service';

/**
 * registry.json "BlockedAccount" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here. Register in AppModule per the SEAM comment there —
 * the dispatcher applies that centrally, this module does not self-register.
 */
@Module({
  controllers: [BlockedAccountController],
  providers: [BlockedAccountService],
})
export class BlockedAccountModule {}
