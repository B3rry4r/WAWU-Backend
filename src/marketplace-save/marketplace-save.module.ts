import { Module } from '@nestjs/common';
import { MarketplaceSaveController } from './marketplace-save.controller';
import { MarketplaceSaveService } from './marketplace-save.service';

@Module({
  controllers: [MarketplaceSaveController],
  providers: [MarketplaceSaveService],
})
export class MarketplaceSaveModule {}
