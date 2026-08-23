import { IsBoolean } from 'class-validator';

/** PATCH /professionals/applications/:id/listing — availability, not approval. */
export class UpdateListingDto {
  @IsBoolean()
  listed!: boolean;
}
