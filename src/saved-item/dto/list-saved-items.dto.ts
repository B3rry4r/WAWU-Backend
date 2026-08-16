import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * Query for GET /users/me/saved per registry.json "SavedItem" contract.
 * `kind` is optional (content|guide|product). This backend's SavedItem
 * table (prisma/schema.prisma) only models content saves — there is no
 * `kind` column and no Prisma model backing guide/product saves (those
 * would be separate registry resources, e.g. MarketplaceSave for
 * products; no "saved guide" resource exists in registry.json at all).
 * Rather than inventing a schema change, `kind=guide` or `kind=product`
 * is honored as a legitimate filter that simply matches nothing in this
 * table (empty page, not an error) — `kind=content` or omitted returns
 * the caller's saved content normally. See saved-item.service.ts.
 */
export class ListSavedItemsDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['content', 'guide', 'product'])
  kind?: 'content' | 'guide' | 'product';
}
