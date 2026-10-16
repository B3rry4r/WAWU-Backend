import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FintavaModule } from '../fintava/fintava.module';
import {
  FintavaOtpSender,
  FintavaWalletProvider,
} from '../fintava/fintava-wallet-provider';
import { NuvionAdapterFactory, NuvionModule } from '../nuvion/nuvion.module';
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
 * the MONEY-06 client exactly as the services used it; `nuvion` builds the
 * Nuvion adapter (NUV-01, src/nuvion/), reading and checking every Nuvion
 * setting then and only then, and its PIN reset codes go by email (R-39).
 * Rolling back is changing the setting and restarting.
 *
 * FintavaModule stays imported whichever is picked: its client is what the
 * Fintava webhook receiver and the Fintava adapter share, and building it
 * sends nothing. Under nuvion a wrong FINTAVA_* value no longer stops the
 * server (the client starts unconfigured instead, NUV-01).
 */
@Module({
  imports: [ConfigModule, FintavaModule, NuvionModule],
  providers: [
    FintavaWalletProvider,
    FintavaOtpSender,
    {
      provide: WALLET_PROVIDER,
      inject: [ConfigService, FintavaWalletProvider, NuvionAdapterFactory],
      useFactory: (
        config: ConfigService,
        fintava: FintavaWalletProvider,
        nuvion: NuvionAdapterFactory,
      ): WalletProvider =>
        selectWalletAdapter<WalletProvider>(
          readWalletProviderName(
            config.get<string>(WALLET_PROVIDER_CONFIG_KEY),
          ),
          { fintava: () => fintava, nuvion: () => nuvion.walletProvider() },
        ),
    },
    {
      // Codes for the PIN reset. Fintava texts them; under nuvion they go
      // by email through WAWU ID (Nuvion has no SMS; R-39).
      provide: OTP_SENDER,
      inject: [ConfigService, FintavaOtpSender, NuvionAdapterFactory],
      useFactory: (
        config: ConfigService,
        sms: FintavaOtpSender,
        nuvion: NuvionAdapterFactory,
      ): OtpSender =>
        selectWalletAdapter<OtpSender>(
          readWalletProviderName(
            config.get<string>(WALLET_PROVIDER_CONFIG_KEY),
          ),
          { fintava: () => sms, nuvion: () => nuvion.otpSender() },
        ),
    },
  ],
  exports: [WALLET_PROVIDER, OTP_SENDER],
})
export class WalletProviderModule {}
