import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const CONTENT_TYPES = [
  'video',
  'course',
  'audio',
  'pdf',
  'image',
  'template',
] as const;
const ACCESS_TYPES = ['free', 'paid'] as const;

/** Body for POST /content per registry.json ContentPiece contract. */
export class CreateContentDto {
  @IsIn(CONTENT_TYPES)
  contentType: (typeof CONTENT_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  category: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsIn(ACCESS_TYPES)
  accessType: (typeof ACCESS_TYPES)[number];

  @IsInt()
  @Min(0)
  @Max(10_000_000)
  price: number;

  @IsUrl({ require_tld: false })
  previewAsset: string;

  @IsUrl({ require_tld: false })
  fullAsset: string;
}
