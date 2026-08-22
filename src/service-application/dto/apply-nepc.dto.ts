import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

/** registry.json § ServiceApplication → POST /services/nepc/apply body. */
export class ApplyNepcDto {
  @IsString()
  @IsNotEmpty()
  rcNumber!: string;

  @IsString()
  @IsNotEmpty()
  exportCategory!: string;

  @IsString()
  @IsNotEmpty()
  mainProduct!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  targetMarkets!: string[];

  @IsString()
  @IsNotEmpty()
  yearlyVolume!: string;

  /**
   * Object-storage URLs for the CAC certificate, product sample photos and
   * bank reference letter the applicant uploads before this call.
   *
   * The NEPC apply screen makes all three mandatory and blocks the submit
   * button until every one has finished uploading — and then sent none of
   * them, because this DTO had no field for them and the global
   * ValidationPipe runs `forbidNonWhitelisted`. Every applicant's documents
   * were being uploaded to object storage and then orphaned. Optional so the
   * currently-shipped client, which still omits them, keeps working.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ require_tld: false }, { each: true })
  documents?: string[];
}
