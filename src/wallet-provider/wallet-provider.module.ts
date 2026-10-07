import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FintavaModule } from '../fintava/fintava.module';
import {
  FintavaOtpSender,
  FintavaWalletProvider,
} from '../fintava/fintava-wallet-provider';
import {
  readWalletProviderName,
  selectWalletAdapter,
  WALLET_PROVIDER_CONFIG_KEY,
} from './wallet-provider-config';
import {
  OTP_SENDER,
  type OtpSender,
  WALLET_PROVIDER,
  type WalletProvider,
} from './wallet-provider.interface';

/**
 * The wallet provider seam's wiring (task MONEY-20): the only place that
 * knows which adapters exist. Every money module imports this one and
 * injects `WALLET_PROVIDER` (and `OTP_SENDER`); none imports a provider's
 * module or client.
 *
 * WALLET_PROVIDER picks the adapter at boot: `fintava` (the default) wraps
 * the MONEY-06 client exactly as the services used it; `nuvion` is reserved
 * and stops the app with a clear message until the Nuvion adapter task adds
 * it here. Rolling back is changing the setting and restarting.
 *
 * FintavaModule stays imported whichever is picked: its client is what the
 * Fintava webhook receiver and the Fintava adapter share, and building it
 * sends nothing.
 */
@Module({
  imports: [ConfigModule, FintavaModule],
  providers: [
    FintavaWalletProvider,
    FintavaOtpSender,
    {
      provide: WALLET_PROVIDER,
      inject: [ConfigService, FintavaWalletProvider],
      useFactory: (
        config: ConfigService,
        fintava: FintavaWalletProvider,
      ): WalletProvider =>
        selectWalletAdapter<WalletProvider>(
          readWalletProviderName(
            config.get<string>(WALLET_PROVIDER_CONFIG_KEY),
          ),
          { fintava: () => fintava },
        ),
    },
    {
      // Codes for the PIN reset. Fintava texts them; the Nuvion task gives
      // this token an email sender (Nuvion has no SMS; the owner rules codes
      // go by email).
      provide: OTP_SENDER,
      inject: [ConfigService, FintavaOtpSender],
      useFactory: (config: ConfigService, sms: FintavaOtpSender): OtpSender =>
        selectWalletAdapter<OtpSender>(
          readWalletProviderName(
            config.get<string>(WALLET_PROVIDER_CONFIG_KEY),
          ),
          { fintava: () => sms },
        ),
    },
  ],
  exports: [WALLET_PROVIDER, OTP_SENDER],
})
export class WalletProviderModule {}
