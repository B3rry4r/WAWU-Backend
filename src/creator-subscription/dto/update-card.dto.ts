import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/** Body for PATCH /creator-subscription/card. */
export class UpdateCardDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(4, {
    message: 'flutterwaveCardToken looks too short to be a real card token',
  })
  flutterwaveCardToken!: string;
}
