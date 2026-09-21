import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WalletService } from './wallet.service';
import { WalletFundingService } from './wallet-funding.service';
import { WalletController } from './wallet.controller';
import { FlutterwaveWalletClient } from './flutterwave-wallet.client';
import { FlutterwaveWalletMock } from './flutterwave-wallet.mock';
import { FLUTTERWAVE_WALLET_GATEWAY } from './flutterwave-wallet.gateway';
import { shouldUseMockFlutterwave } from '../common/flutterwave/require-payment-config';

/**
 * Creator wallets, held at Flutterwave MFB.
 *
 * The gateway is chosen the same way every other money module chooses one, and
 * shouldUseMockFlutterwave() throws rather than returning true in production,
 * so a deploy missing FLUTTERWAVE_SECRET_KEY cannot boot into a state where
 * withdrawals silently succeed without moving money.
 */
@Module({
  imports: [ConfigModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletFundingService,
    {
      provide: FLUTTERWAVE_WALLET_GATEWAY,
      useClass: shouldUseMockFlutterwave() ? FlutterwaveWalletMock : FlutterwaveWalletClient,
    },
  ],
  /**
   * The gateway is exported alongside the service because the admin money
   * surface (src/admin/finance) reports Flutterwave's balance and must read
   * it through THIS provider rather than constructing a second client. One
   * provider means one answer to "what is in this wallet", and it means the
   * admin surface inherits the same production guard: shouldUseMockFlutterwave()
   * throws rather than degrading when FLUTTERWAVE_SECRET_KEY is absent.
   */
  exports: [WalletService, FLUTTERWAVE_WALLET_GATEWAY],
})
export class WalletModule {}
