import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

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
}
