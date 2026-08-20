import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { PlaybookService } from './playbook.service';
import type { PlaybookResponse } from '../common/types';
import { AdminKeyGuard } from '../common/guards/admin-key.guard';
import { UpdatePlaybookDto } from './dto/update-playbook.dto';

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

  /**
   * Operator upload. The playbook was seeded text with no file behind it, so
   * there was no way to publish an actual document. Behind the operator key
   * rather than the normal user guard: this is not something a creator does.
   */
  @Patch()
  @UseGuards(AdminKeyGuard)
  updatePlaybook(@Body() dto: UpdatePlaybookDto) {
    return this.playbookService.updatePlaybook(dto);
  }
}
