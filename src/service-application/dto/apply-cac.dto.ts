import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

/** registry.json § ServiceApplication → POST /services/cac/apply body. */
export class ApplyCacDto {
  @IsString()
  @IsNotEmpty()
  registrationType!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  names!: string[];

  @IsString()
  @IsNotEmpty()
  nature!: string;

  /**
   * Object-storage URLs for the supporting documents (valid ID, signature,
   * passport photograph), uploaded via POST /uploads/presign before this
   * call. Optional so existing clients keep working.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUrl({ require_tld: false }, { each: true })
  documents?: string[];
}
