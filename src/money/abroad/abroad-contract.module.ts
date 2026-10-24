import { Module } from '@nestjs/common';
import { AbroadAdminContractController } from './abroad-admin-contract.controller';
import { AbroadContractController } from './abroad-contract.controller';

/**
 * The send-abroad routes of task NUV-11 (R-84), declared before they are
 * served, as FxContractModule declares WALLET-21's: AppModule does not import
 * this module and nothing may. It has no providers, so a declared handler
 * carries the documentation of its guards, not the guards.
 * src/openapi/emit-openapi.ts reads it into contract/openapi.json beside the
 * served routes, marked `x-wawu-served: false`. When the second milestone
 * serves these routes this module is deleted, the emitter loses its line, and
 * the same change removes the declarations (the emitter refuses a route that
 * is both served and declared).
 */
@Module({
  controllers: [AbroadContractController, AbroadAdminContractController],
})
export class AbroadContractModule {}
