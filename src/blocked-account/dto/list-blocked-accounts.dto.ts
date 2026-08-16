import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/**
 * Query for GET /settings/privacy/blocked per registry.json "BlockedAccount"
 * contract — no filters beyond conventions.md's standard page/perPage.
 */
export class ListBlockedAccountsDto extends PaginationQueryDto {}
