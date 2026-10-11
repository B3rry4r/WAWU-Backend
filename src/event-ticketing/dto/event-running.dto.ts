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

/**
 * POST /events/:id/door/check-in: one scan at the door.
 *
 * The door answers EVERY scan with a verdict. A phone camera reads whatever
 * QR is in front of it (a flyer's link, a poster, a wifi code), and "this is
 * not a ticket" is the red result on E24, not a validation error. So the body
 * accepts any text a scanner can hand over, up to `MAX_DOOR_SCAN_LENGTH`,
 * where the host-only protected scan (`ScanTicketDto`, 40) keeps its own
 * limit untouched. The service decides whether the text can be a ticket code.
 */
export const MAX_DOOR_SCAN_LENGTH = 500;

export class DoorScanDto {
  @IsString()
  @MinLength(4)
  @MaxLength(MAX_DOOR_SCAN_LENGTH)
  code!: string;
}
