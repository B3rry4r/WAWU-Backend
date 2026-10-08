import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runningWalletLines } from '../money/opening/wallet-opening-config';
import type { AboutView } from './about-view.type';

export const SUPPORT_EMAIL_KEY = 'SUPPORT_EMAIL';

function line(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}

/**
 * What About shows (task SETTINGS-02). The bank name and licence line are the
 * very keys the wallet screens read (WALLET_BANK_NAME, WALLET_LICENCE_LINE;
 * under WALLET_PROVIDER=nuvion the NUVION_WALLET_* ones, NUV-01), so About
 * and the wallet can never name different banks (R-1). The support
 * address has no default: it is a fact the owner supplies.
 */
@Injectable()
export class AboutSettings {
  constructor(private readonly config: ConfigService) {}

  view(): AboutView {
    const get = (key: string) => this.config.get<string>(key);
    // The running provider's lines (NUV-01): the same ones the wallet shows.
    const wallet = runningWalletLines(get);
    return {
      bankName: wallet.bankName,
      licenceLine: wallet.licenceLine,
      supportEmail: line(get(SUPPORT_EMAIL_KEY)),
    };
  }
}
