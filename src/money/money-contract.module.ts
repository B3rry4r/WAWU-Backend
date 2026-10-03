import { Module } from '@nestjs/common';
import { MoneyPaymentController } from './money-payment.controller';
import { MoneyTransferController } from './money-transfer.controller';

/**
 * The Naira wallet contract (task MONEY-04): routes declared, not served.
 *
 * AppModule does not import this module, and nothing may: it has no
 * providers, and every handler in it is a declaration (money-contract.ts).
 * src/openapi/emit-openapi.ts reads it into contract/openapi.json beside the
 * served routes, marked `x-wawu-served: false`. A task that serves one of
 * these routes moves that handler into a controller a mounted module owns
 * and deletes it here in the same change; the emitter refuses a route that
 * is declared here and served as well. Served so far: the transaction PIN
 * (MONEY-09, MoneyModule), the balance (MONEY-11), the wallet itself
 * (MONEY-12), the history (MONEY-15) and the fee quote (WALLET-15).
 */
@Module({
  controllers: [MoneyTransferController, MoneyPaymentController],
})
export class MoneyContractModule {}
