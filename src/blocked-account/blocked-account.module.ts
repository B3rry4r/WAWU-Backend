import { Global, Module } from '@nestjs/common';
import { BlockedAccountController } from './blocked-account.controller';
import { BlockedAccountService } from './blocked-account.service';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';

/**
 * registry.json "BlockedAccount" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here. Register in AppModule per the SEAM comment there —
 * the dispatcher applies that centrally, this module does not self-register.
 *
 * @Global() + `exports` was added when blocking gained an effect. A block is
 * only real if the interactions it forbids actually consult it, so
 * BlockedAccountService.assertNotBlocked() has to be callable from every
 * module that owns one of those interactions (paid DMs, tips, follows,
 * comments) — one constructor parameter and one line each. Modules that gate
 * on it still list this module in their own `imports` as well, because a
 * @Global() provider is only visible once the module is somewhere in the
 * graph, and the per-resource contract specs each build a testing module
 * from just their own resource's module.
 *
 * WawuAuthModule supplies WawuIdClient, which list() batch-calls to attach
 * each row's blocked-user identity (same source CreatorDiscoveryService
 * already uses).
 */
@Global()
@Module({
  imports: [WawuAuthModule],
  controllers: [BlockedAccountController],
  providers: [BlockedAccountService],
  exports: [BlockedAccountService],
})
export class BlockedAccountModule {}
