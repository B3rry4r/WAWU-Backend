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
  exports: [WalletService],
})
export class WalletModule {}
