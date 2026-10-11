import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Response } from 'express';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { CommunityMessageService } from './community-message.service';
import { CreateCommunityMessageDto } from './dto/create-community-message.dto';
import type { CommunityMessage } from '../common/types';

/**
 * The shape an `Idempotency-Key` takes everywhere in the Hub (docs/contract/
 * CONVENTIONS.md section 4): 8 to 128 characters of letters, digits, hyphen
 * and underscore.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The header is optional on this route. Absent: the send runs exactly as it
 * always has. Present: it must be one well-formed value, or nothing is sent
 * (a charge must never hang on a key the Hub cannot hold).
 */
function readIdempotencyKey(
  header: string | string[] | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new BadRequestException(
      'Idempotency-Key must be one value of 8 to 128 letters, digits, hyphens or underscores.',
    );
  }
  return header;
}

/**
 * Frozen CommunityMessage contract: GET/POST /communities/:id/messages,
 * both `roles: ["any"]` — any authenticated WAWU user. POST additionally
 * carries the CreditsState paid-messaging gate documented on
 * CommunityMessageService.create().
 */
@UseGuards(WawuAuthGuard)
@Controller('communities/:id/messages')
export class CommunityMessageController {
  constructor(
    private readonly communityMessageService: CommunityMessageService,
  ) {}

  @Get()
  list(
    @Param('id', ParseUUIDPipe) communityId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: PaginationQueryDto,
  ) {
    return this.communityMessageService.list(
      communityId,
      user.sub,
      query.page,
      query.perPage,
    );
  }

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. One value per message, made by the app when the person first sends it and sent again unchanged on every retry of that same message (never reused for another). Per sender and key the message is stored and charged once; a repeat answers with the first message as stored (the same status and body) and the header `Idempotent-Replayed: true`. The same key for other words or another room is `409` with `reason: idempotency_key_reused`. Without it the send behaves as it always has.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  })
  async create(
    @Param('id', ParseUUIDPipe) communityId: string,
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: CreateCommunityMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CommunityMessage> {
    const key = readIdempotencyKey(idempotencyKey);
    const sent = await this.communityMessageService.create(
      communityId,
      user.sub,
      dto,
      key,
    );
    if (sent.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return sent.message;
  }
}
