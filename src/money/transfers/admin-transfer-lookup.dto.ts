import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** `GET /admin/money/transfers/lookup`. */
export class AdminTransferLookupQueryDto {
  @ApiProperty({
    maxLength: 120,
    description:
      'The short reference a person quotes ("WAW-8F2A-91C3") or the whole stored reference ("wawu-send-<id>", "wawu-bank-<id>").',
  })
  @IsString()
  @Length(4, 120)
  reference!: string;
}
