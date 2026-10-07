import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * POST /events/:id/door-staff: who the host lets check tickets in.
 *
 * The person is named by exactly one of their WAWU id or their handle (the
 * service refuses both or neither). `label` is what the door result prints
 * after "by" (E23 "Checked in at 09:52 by Door 1"); left out, it is
 * "Door <n>".
 */
export class AddDoorStaffDto {
  @IsOptional()
  @IsUUID()
  wawuUserId?: string;

  /** With or without the "@". Same characters a handle may hold. */
  @IsOptional()
  @IsString()
  @MaxLength(31)
  @Matches(/^@?[a-zA-Z0-9_.]+$/, {
    message: 'handle may only contain letters, numbers, underscores, and dots',
  })
  handle?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  label?: string;
}
