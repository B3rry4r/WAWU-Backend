import { ArrayMinSize, IsArray, IsNotEmpty, IsString } from 'class-validator';

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
}
