import { Global, Module } from '@nestjs/common';
import { VerificationStateService } from './verification-state.service';
import { VerificationPricingService } from './verification-pricing';

/**
 * Reading the two ticks, and what they cost. No controllers, on purpose.
 *
 * Every user-shaped response carries `verification` - profiles, creator
 * discovery, professional listings, search hits, comment authors, event
 * hosts - so this is a dependency of most feature modules. Two things follow
 * from that, and both are why this is separate from VerificationModule:
 *
 *  1. It is @Global(), so a feature module gets the reader without a
 *     ceremonial import. Threading one read through nine modules is the kind
 *     of plumbing that ends with somebody inlining the date comparison
 *     instead, which is exactly what deriveVerificationState exists to stop.
 *
 *  2. It declares NO controller, so a feature module that DOES import it
 *     explicitly - EventModule needs to, because its contract spec boots it
 *     alone and @Global() only helps once a module is somewhere in the graph
 *     - drags no routes in with it. Route registration order in this backend
 *     is decided by first encounter during AppModule's walk, and moving one
 *     has taken production down before (see route-shadowing.regression).
 *
 * The buying and granting half lives in VerificationModule, which has the
 * controllers and imports this.
 */
@Global()
@Module({
  providers: [VerificationStateService, VerificationPricingService],
  exports: [VerificationStateService, VerificationPricingService],
})
export class VerificationStateModule {}
