import { IsEnum, IsOptional } from 'class-validator';
import { NotificationCampaignStatus } from '../../../../generated/prisma/enums';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * GET /admin/notifications/campaigns query.
 *
 * Newest first, unlike the moderation queues. A campaign list is not a queue
 * of work waiting on somebody: it is a send history, and the question it
 * answers is "what went out, and how did it land", which is always about the
 * most recent one.
 */
export class AdminCampaignQueryDto extends PaginationQueryDto {
  /** Omitted means every status, drafts included. */
  @IsOptional()
  @IsEnum(NotificationCampaignStatus)
  status?: NotificationCampaignStatus;
}
