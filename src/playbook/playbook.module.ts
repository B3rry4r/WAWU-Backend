import { Module } from '@nestjs/common';
import { PlaybookController } from './playbook.controller';
import { PlaybookService } from './playbook.service';

@Module({
  controllers: [PlaybookController],
  providers: [PlaybookService],
})
export class PlaybookModule {}
