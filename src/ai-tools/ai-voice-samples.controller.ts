import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { BuiltBy } from '../money/money-contract';
import { AiToolsService } from './ai-tools.service';

/**
 * A short sample of a listed voice (AITOOLS-07, PT2's play button,
 * G-POINTS-08-1). Public: it is the voice's own preview, the same for everyone,
 * and a phone's audio player on the web cannot send a token. The Hub serves the
 * bytes itself so the catalogue never carries the provider's address (R-68); a
 * voice that is not listed, or has no sample, is a plain 404.
 */
@Controller('ai-tools/voices')
export class AiVoiceSamplesController {
  constructor(private readonly tools: AiToolsService) {}

  @Get(':voiceId/sample')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOkResponse({
    description: 'The sample, as audio.',
    content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } },
  })
  @BuiltBy('AITOOLS-07')
  async sample(
    @Param('voiceId') voiceId: string,
    @Res() res: Response,
  ): Promise<void> {
    const sample = /^[a-z0-9_-]{1,40}$/.test(voiceId)
      ? await this.tools.sample(voiceId)
      : null;
    if (!sample) throw new NotFoundException('We could not find that sample.');
    // The audio itself, not the Hub's JSON envelope (the player reads it as a file).
    // The Hub's default is same-origin: a web app on another address would have its player
    // blocked ("NotSameOrigin"), so this one public preview says any page may play it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type(sample.contentType).send(sample.audio);
  }
}
