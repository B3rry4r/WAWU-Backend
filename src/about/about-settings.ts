import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_WALLET_BANK_NAME,
  WALLET_OPENING_CONFIG_KEYS,
} from '../money/opening/wallet-opening-config';
import type { AboutView } from './about-view.type';

export const SUPPORT_EMAIL_KEY = 'SUPPORT_EMAIL';

function line(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}

/**
 * What About shows (task SETTINGS-02). The bank name and licence line are the
 * very keys the wallet screens read (WALLET_BANK_NAME, WALLET_LICENCE_LINE),
 * so About and the wallet can never name different banks (R-1). The support
 * address has no default: it is a fact the owner supplies.
 */
@Injectable()
export class AboutSettings {
  constructor(private readonly config: ConfigService) {}

  view(): AboutView {
    const get = (key: string) => this.config.get<string>(key);
    return {
      bankName:
        line(get(WALLET_OPENING_CONFIG_KEYS.bankName)) ??
        DEFAULT_WALLET_BANK_NAME,
      licenceLine: line(get(WALLET_OPENING_CONFIG_KEYS.licenceLine)),
      supportEmail: line(get(SUPPORT_EMAIL_KEY)),
    };
  }
}
