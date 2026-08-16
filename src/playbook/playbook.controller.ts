import { Controller, Get, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PlaybookService } from './playbook.service';
import type { PlaybookResponse } from '../common/types';

/**
 * registry.json § Playbook — one endpoint only:
 *   GET /learn/playbook  roles: ["any"]
 * (global prefix `api/hub` set in main.ts, so the wire route is
 * `GET /api/hub/learn/playbook`).
 */
@Controller('learn/playbook')
@UseGuards(WawuAuthGuard)
export class PlaybookController {
  constructor(private readonly playbookService: PlaybookService) {}

  @Get()
  getPlaybook(): Promise<PlaybookResponse> {
    return this.playbookService.getPlaybook();
  }
}
