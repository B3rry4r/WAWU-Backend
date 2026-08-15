import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  health(): { ok: boolean; service: string } {
    return { ok: true, service: 'wawu-hub-api' };
  }
}
