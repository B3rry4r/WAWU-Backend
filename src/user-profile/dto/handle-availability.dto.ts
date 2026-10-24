import { IsOptional, IsString, MaxLength } from 'class-validator';

/** GET /users/handle-available?handle= (SIGNUP-NAMES, closes G-111). */
export class HandleAvailabilityQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  handle?: string;
}

export interface HandleAvailabilityView {
  /** The name as it would be kept: no "@", no spaces around it. Empty when nothing usable was typed. */
  handle: string;
  /** True when the name can be used: well formed, not held back, and nobody else has it (ignoring case). */
  available: boolean;
  /** The server's sentence when it cannot be used; null when it can. */
  message: string | null;
}
