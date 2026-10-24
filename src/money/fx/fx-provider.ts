import { Inject, Injectable } from '@nestjs/common';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type {
  ProviderForeignAccounts,
  ProviderFxPerson,
} from '../../wallet-provider/wallet-provider-fx';

export const NOT_SUPPORTED_MESSAGE =
  'Foreign currency accounts are not available on this wallet yet.';

/** Words of ours that must never be shown as the provider's reason. */
const OWN_PREFIX = /WALLET-21|\(NUV-|\(MONEY-/;

/**
 * The foreign-currency part of the running wallet provider, reached only
 * through `WALLET_PROVIDER` (R-39). A provider without it (Fintava) is
 * `currency_not_supported`, never a guess.
 */
@Injectable()
export class FxPort {
  constructor(@Inject(WALLET_PROVIDER) readonly provider: WalletProvider) {}

  get name(): string {
    return this.provider.name;
  }

  get(): ProviderForeignAccounts {
    const fx = this.provider.fx;
    if (!fx || !this.provider.configured) {
      throw new MoneyError('currency_not_supported', NOT_SUPPORTED_MESSAGE);
    }
    return fx;
  }

  /** True when this server's provider holds foreign accounts at all. */
  get supported(): boolean {
    return !!this.provider.fx && this.provider.configured;
  }

  person(
    wallet: Pick<OpenWallet, 'customerId' | 'walletId'>,
  ): ProviderFxPerson {
    return { customerId: wallet.customerId, walletId: wallet.walletId };
  }
}

/** What the person is told when the provider declines without a reason of its own. */
const DECLINED =
  'The provider could not do that right now. Nothing was moved. Try again later.';

/**
 * A provider failure as the Hub's answer. A refusal in the provider's own
 * words (masked by the adapter) is `provider_declined` with those words;
 * a lost or slow answer is `provider_unreachable`; a missing thing is
 * `not_found`. Anything that is not a provider failure is a bug and passes
 * through.
 */
export function providerFailure(
  e: unknown,
  detail: { currency?: string; balanceMinor?: number } = {},
): unknown {
  if (!(e instanceof WalletProviderError)) return e;
  switch (e.kind) {
    case 'not_supported':
      return new MoneyError('currency_not_supported', NOT_SUPPORTED_MESSAGE);
    case 'insufficient_funds':
      return new MoneyError(
        'insufficient_funds',
        'There is not enough in the account for this.',
        {
          ...(detail.currency ? { currency: detail.currency } : {}),
          ...(detail.balanceMinor !== undefined
            ? { balanceMinor: detail.balanceMinor }
            : {}),
        },
      );
    case 'below_minimum':
      return new MoneyError(
        'amount_out_of_range',
        'That amount is below the minimum.',
      );
    case 'not_found':
      return new MoneyError('not_found', 'We could not find that.');
    case 'refused':
    case 'validation':
    case 'wallet_inactive':
    case 'payouts_blocked':
    case 'identity_refused':
    case 'under_review':
    case 'merchant_inactive': {
      const own = e.messages[0];
      const said =
        own && !OWN_PREFIX.test(own) && own.length <= 300 ? own : DECLINED;
      // R-5: nothing a person reads carries a long dash, the provider's words included.
      return new MoneyError(
        'provider_declined',
        said.replace(/[\u2013\u2014]/g, ','),
      );
    }
    default:
      return e.toHttpException();
  }
}
