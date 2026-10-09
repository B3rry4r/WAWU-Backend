import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NuvionClient } from './nuvion-client';
import { readNuvionSettings } from './nuvion-config';
import { NuvionOtpSender } from './nuvion-otp-sender';
import { NuvionWalletProvider } from './nuvion-wallet-provider';

/**
 * Builds the Nuvion adapter, its client and its code sender, once, and only
 * when asked (task NUV-01). WalletProviderModule asks only when
 * WALLET_PROVIDER=nuvion, so a server on Fintava never reads a Nuvion
 * setting and a missing or wrong one cannot stop it. Under nuvion the first
 * ask reads and checks every setting (nuvion-config.ts): a missing one, or
 * a base URL other than Nuvion's two hosts, stops the server at boot naming
 * it. Building sends nothing to Nuvion.
 */
@Injectable()
export class NuvionAdapterFactory {
  private readonly logger = new Logger(NuvionAdapterFactory.name);
  private built: {
    client: NuvionClient;
    provider: NuvionWalletProvider;
  } | null = null;
  private sender: NuvionOtpSender | null = null;

  constructor(private readonly config: ConfigService) {}

  /** The client every area calls through. */
  client(): NuvionClient {
    return this.build().client;
  }

  walletProvider(): NuvionWalletProvider {
    return this.build().provider;
  }

  /** The PIN reset's email sender (R-39: codes go by email). */
  otpSender(): NuvionOtpSender {
    this.sender ??= new NuvionOtpSender(this.config);
    return this.sender;
  }

  private build(): { client: NuvionClient; provider: NuvionWalletProvider } {
    if (this.built) return this.built;
    const { settings, apiKey } = readNuvionSettings((key) =>
      this.config.get<string>(key),
    );
    const client = new NuvionClient(settings, apiKey);
    this.built = { client, provider: new NuvionWalletProvider(client) };
    this.logger.log(`Nuvion adapter ready (${settings.environment})`);
    return this.built;
  }
}

/**
 * The Nuvion gateway (task NUV-01): the adapter factory, no routes. Imported
 * by WalletProviderModule, the only place that picks a provider. Nuvion's
 * webhook receiver is its own module (src/nuvion/webhook/), mounted under
 * every WALLET_PROVIDER so a delivery is never lost to a rollback.
 */
@Module({
  imports: [ConfigModule],
  providers: [NuvionAdapterFactory],
  exports: [NuvionAdapterFactory],
})
export class NuvionModule {}
