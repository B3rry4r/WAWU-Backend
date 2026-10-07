import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

/** GET /events/tickets/held. Offset pages, like the public calendar. */
export class HeldTicketsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  view: 'upcoming' | 'past' = 'upcoming';
}
