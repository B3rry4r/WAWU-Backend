import { IsIn, IsOptional, IsString } from 'class-validator';
import { GuideKind } from '../../../generated/prisma/enums';

/**
 * Optional read-side filters for `GET /learn/guides`. Not a registry field,
 * but `kind`/`country` are the two columns the schema agent explicitly
 * indexed on LearnGuide (`@@index([kind])`, `@@index([country])`) — this
 * DTO is the natural, contract-preserving way to make that indexing useful
 * without adding a new endpoint or a field the registry didn't list.
 */
export class ListLearnGuidesQueryDto {
  @IsOptional()
  @IsIn(Object.values(GuideKind))
  kind?: GuideKind;

  @IsOptional()
  @IsString()
  country?: string;
}
