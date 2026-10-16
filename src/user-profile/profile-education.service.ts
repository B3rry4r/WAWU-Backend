import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  CreateProfileEducationDto,
  UpdateProfileEducationDto,
} from './dto/profile-education.dto';
import {
  EDUCATION_END_YEARS_AHEAD,
  EDUCATION_FIELD_MAX,
  EDUCATION_SCHOOL_MAX,
  FIRST_YEAR,
  MAX_EDUCATION,
  assertYear,
  cleanText,
  latestWorkYear,
  requiredText,
} from './profile-works';
import {
  isSafeLookupKey,
  ProfileAudienceService,
} from './profile-audience.service';
import type { ProfileEducationView } from './profile-work.type';

const NOT_FOUND = 'Education not found';

/**
 * Education (ME-16): the school, field of study and years M33 shows under
 * "Education".
 *
 * Same rules as the works beside it: only the owner writes, from the token,
 * with the owner in the WHERE clause; a visitor reads what ProfileAudience
 * lets them; the cap is held by a per-person advisory lock so a double tap
 * cannot take an eleventh slot. A NULL `endYear` is "still studying there".
 */
@Injectable()
export class ProfileEducationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: ProfileAudienceService,
  ) {}

  private async lock(
    tx: Prisma.TransactionClient,
    owner: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`profile-education:${owner}`}, 0))`;
  }

  private toView(row: {
    id: string;
    school: string;
    field: string | null;
    startYear: number;
    endYear: number | null;
  }): ProfileEducationView {
    return {
      id: row.id,
      school: row.school,
      field: row.field,
      startYear: row.startYear,
      endYear: row.endYear,
      current: row.endYear === null,
    };
  }

  /**
   * The year rules, checked against what the row WILL hold (an edit that
   * sends only `endYear` is compared with the stored `startYear`).
   */
  private assertYears(startYear: number, endYear: number | null): void {
    const latest = latestWorkYear();
    assertYear(startYear, 'Start year', FIRST_YEAR, latest);
    if (endYear !== null) {
      assertYear(
        endYear,
        'End year',
        FIRST_YEAR,
        latest + EDUCATION_END_YEARS_AHEAD - 1,
      );
      if (endYear < startYear) {
        throw new BadRequestException(
          'End year cannot be before the start year',
        );
      }
    }
  }

  /** Still studying first, then the latest start. A stable tie-break on id. */
  async list(owner: string): Promise<ProfileEducationView[]> {
    const rows = await this.prisma.profileEducation.findMany({
      where: { wawuUserId: owner },
      orderBy: [
        { endYear: { sort: 'desc', nulls: 'first' } },
        { startYear: 'desc' },
        { id: 'asc' },
      ],
    });
    return rows.map((r) => this.toView(r));
  }

  async listFor(
    idOrHandle: string,
    viewer: string,
  ): Promise<ProfileEducationView[]> {
    const owner = await this.audience.resolveVisible(idOrHandle, viewer);
    return this.list(owner);
  }

  async create(
    owner: string,
    dto: CreateProfileEducationDto,
  ): Promise<ProfileEducationView> {
    const school = requiredText(dto.school, 'School', {
      max: EDUCATION_SCHOOL_MAX,
    });
    const field =
      dto.field == null
        ? null
        : cleanText(dto.field, 'Field of study', { max: EDUCATION_FIELD_MAX });
    const endYear = dto.endYear ?? null;
    this.assertYears(dto.startYear, endYear);

    const row = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, owner);
      const count = await tx.profileEducation.count({
        where: { wawuUserId: owner },
      });
      if (count >= MAX_EDUCATION) {
        throw new BadRequestException(
          `A profile can list at most ${MAX_EDUCATION} schools. Remove one to add another.`,
        );
      }
      return tx.profileEducation.create({
        data: {
          wawuUserId: owner,
          school,
          field,
          startYear: dto.startYear,
          endYear,
        },
      });
    });
    return this.toView(row);
  }

  async update(
    owner: string,
    id: string,
    dto: UpdateProfileEducationDto,
  ): Promise<ProfileEducationView> {
    if (!isSafeLookupKey(id)) throw new NotFoundException(NOT_FOUND);
    const data: Prisma.ProfileEducationUpdateManyMutationInput = {};
    if (dto.school !== undefined)
      data.school = requiredText(dto.school, 'School', {
        max: EDUCATION_SCHOOL_MAX,
      });
    if (dto.field !== undefined)
      data.field =
        dto.field === null
          ? null
          : cleanText(dto.field, 'Field of study', {
              max: EDUCATION_FIELD_MAX,
            });
    if (dto.startYear !== undefined) data.startYear = dto.startYear;
    if (dto.endYear !== undefined) data.endYear = dto.endYear;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Send at least one field to change.');
    }

    // The years are compared with the row as it stands, inside one
    // transaction with the write, so a concurrent edit of the other end
    // cannot slip an end year before a start year past the check.
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, owner);
      const current = await tx.profileEducation.findFirst({
        where: { id, wawuUserId: owner },
      });
      if (!current) throw new NotFoundException(NOT_FOUND);
      if (dto.startYear !== undefined || dto.endYear !== undefined) {
        this.assertYears(
          dto.startYear ?? current.startYear,
          dto.endYear === undefined ? current.endYear : dto.endYear,
        );
      }
      await tx.profileEducation.updateMany({
        where: { id, wawuUserId: owner },
        data,
      });
    });
    const row = await this.prisma.profileEducation.findFirst({
      where: { id, wawuUserId: owner },
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return this.toView(row);
  }

  async remove(owner: string, id: string): Promise<{ deleted: true }> {
    if (!isSafeLookupKey(id)) throw new NotFoundException(NOT_FOUND);
    const { count } = await this.prisma.profileEducation.deleteMany({
      where: { id, wawuUserId: owner },
    });
    if (count === 0) throw new NotFoundException(NOT_FOUND);
    return { deleted: true };
  }
}
