import { Module } from '@nestjs/common';
import { FxAdminContractController } from './fx-admin-contract.controller';
import { FxContractController } from './fx-contract.controller';

/**
 * The foreign-currency routes of task WALLET-21 (R-83, R-84), declared before
 * they are served, exactly as MoneyContractModule declares the naira wallet's:
 * AppModule does not import this module and nothing may. It has no providers,
 * so a declared handler carries the documentation of its guards, not the
 * guards. src/openapi/emit-openapi.ts reads it into contract/openapi.json
 * beside the served routes, marked `x-wawu-served: false`.
 *
 * It is a module of its own because MoneyContractModule's specs pin that
 * module to "declares nothing" (money-contract.spec.ts, the wallet gate and
 * limit coverage specs) and WALLET-21 does not edit another task's
 * assertions. When the second milestone serves these routes from MoneyModule
 * this module is deleted, the emitter loses its line, and the same change
 * removes the declarations (the emitter refuses a route served and declared).
 */
@Module({
  controllers: [FxContractController, FxAdminContractController],
})
export class FxContractModule {}
