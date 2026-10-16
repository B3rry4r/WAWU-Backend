import { Module } from '@nestjs/common';

/**
 * The Naira wallet contract (task MONEY-04): routes declared, not served.
 *
 * AppModule does not import this module, and nothing may: it has no
 * providers, and every handler declared in it is a declaration
 * (money-contract.ts). src/openapi/emit-openapi.ts reads it into
 * contract/openapi.json beside the served routes, marked
 * `x-wawu-served: false`. A task that serves one of these routes moves that
 * handler into a controller a mounted module owns and deletes it here in the
 * same change; the emitter refuses a route that is declared here and served
 * as well.
 *
 * Every route MONEY-04 declared is served now: the transaction PIN
 * (MONEY-09, MoneyModule), the balance (MONEY-11), the wallet itself
 * (MONEY-12), the history (MONEY-15), the fee quote (WALLET-15), the
 * recipient search and recent recipients (WALLET-08), the payment (MONEY-17)
 * and its poll (MONEY-19), the holds (MONEY-18), the send to a WAWU user with
 * the read of one send (WALLET-07), and the bank list, the name check and the
 * send to a bank account (WALLET-09). The module stays, empty, for the next
 * route that is declared before it is built.
 */
@Module({
  controllers: [],
})
export class MoneyContractModule {}
