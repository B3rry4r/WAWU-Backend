import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';

/**
 * What the nightly check looks at, beyond "the rows of the provider this
 * server runs" (task MONEY-16). The default is everything: every wallet,
 * every payment, every hold and every ledger row of that provider. A run
 * made on purpose over a few wallets, or a spec that owns only some of the
 * rows in a shared database, narrows it by providing its own scope; each
 * fragment is combined with the provider test by AND and can only narrow it.
 */
@Injectable()
export class MoneyCheckScope {
  /** Added to the wallet query. */
  walletWhere(): Prisma.FintavaWalletWhereInput {
    return {};
  }

  /** Added to every ledger row query that is not about one wallet. */
  ledgerWhere(): Prisma.FintavaLedgerEntryWhereInput {
    return {};
  }

  paymentWhere(): Prisma.WalletPaymentWhereInput {
    return {};
  }

  holdWhere(): Prisma.WalletHoldWhereInput {
    return {};
  }
}
