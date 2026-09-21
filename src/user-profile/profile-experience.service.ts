import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  CreateProfileExperienceDto,
  UpdateProfileExperienceDto,
} from './dto/profile-experience.dto';
import { MAX_EXPERIENCE_ROWS } from './dto/profile-experience.dto';
import type { ProfileExperienceView } from './profile-experience.type';

/**
 * The experience list on a profile: what somebody did, where, and when.
 *
 * ── WHY THIS IS ITS OWN SERVICE ────────────────────────────────────────────
 *
 * UserProfileService is already a thousand lines and owns the profile
 * aggregate, name proxying to WAWU ID, handle uniqueness, image re-signing
 * and the stats roll-up. Four CRUD handlers over one table share none of
 * that. They live here so the aggregate keeps one job, and so a change to
 * how a role is validated cannot reach the code that decides whether a handle
 * is taken.
 *
 * ── MONTHS, NOT DATES ──────────────────────────────────────────────────────
 *
 * The wire format is "YYYY-MM" and the column is a DATE pinned to the first
 * of that month. Both conversions live in this file and nowhere else, which
 * is the point: a second place that built a Date from a month string would
 * eventually build it in local time, and half the world would see every role
 * start a month early.
 */
@Injectable()
export class ProfileExperienceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "2023-03" to the Date the column stores.
   *
   * Date.UTC, never `new Date("2023-03")`: the string form is parsed as UTC
   * by the spec but a bare "2023-3-1" is parsed as LOCAL time, and the two
   * differ by up to a day. Building the parts explicitly means the stored
   * value cannot drift with the server's timezone.
   */
  private monthToDate(month: string): Date {
    const [year, mon] = month.split('-').map(Number);
    return new Date(Date.UTC(year, mon - 1, 1));
  }

  /** The Date back to "2023-03", read in UTC for the same reason. */
  private dateToMonth(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * A role is invalid if it ended before it began. Checked on create and on
   * every update, against the values that will actually be stored rather than
   * the ones that arrived: a PATCH sending only `endedOn` has to be compared
   * with the `startedOn` already in the row, which is the case a naive
   * "validate the DTO" check misses entirely.
   */
  private assertOrdered(startedOn: Date, endedOn: Date | null): void {
    if (endedOn && endedOn.getTime() < startedOn.getTime()) {
      throw new BadRequestException('endedOn cannot be before startedOn');
    }
  }

  private toView(row: {
    id: string;
    title: string;
    company: string;
    location: string | null;
    startedOn: Date;
    endedOn: Date | null;
    description: string | null;
  }): ProfileExperienceView {
    return {
      id: row.id,
      title: row.title,
      company: row.company,
      location: row.location,
      startedOn: this.dateToMonth(row.startedOn),
      endedOn: row.endedOn ? this.dateToMonth(row.endedOn) : null,
      // Derived, never stored. See the schema comment: a `current` column
      // beside `endedOn` is two facts that can disagree.
      current: row.endedOn === null,
      description: row.description,
    };
  }

  /**
   * One person's roles, current first and then newest first.
   *
   * The ordering is two keys rather than one because a role with no end date
   * is the one they hold NOW, and it belongs at the top even when an older
   * finished role started later. Postgres sorts NULLs last on DESC by
   * default, so `endedOn DESC NULLS FIRST` is stated explicitly instead of
   * being left to the default and quietly burying the current job.
   */
  async list(wawuUserId: string): Promise<ProfileExperienceView[]> {
    const rows = await this.prisma.profileExperience.findMany({
      where: { wawuUserId },
      orderBy: [
        { endedOn: { sort: 'desc', nulls: 'first' } },
        { startedOn: 'desc' },
      ],
    });
    return rows.map((r) => this.toView(r));
  }

  async create(
    wawuUserId: string,
    dto: CreateProfileExperienceDto,
  ): Promise<ProfileExperienceView> {
    const startedOn = this.monthToDate(dto.startedOn);
    const endedOn = dto.endedOn ? this.monthToDate(dto.endedOn) : null;
    this.assertOrdered(startedOn, endedOn);

    // Counted immediately before the insert rather than trusted from a
    // client-side list length. Two tabs can both think there are 14.
    const existing = await this.prisma.profileExperience.count({
      where: { wawuUserId },
    });
    if (existing >= MAX_EXPERIENCE_ROWS) {
      throw new BadRequestException(
        `A profile can list at most ${MAX_EXPERIENCE_ROWS} roles. Remove one to add another.`,
      );
    }

    const row = await this.prisma.profileExperience.create({
      data: {
        wawuUserId,
        title: dto.title,
        company: dto.company,
        location: dto.location ?? null,
        startedOn,
        endedOn,
        description: dto.description ?? null,
      },
    });
    return this.toView(row);
  }

  /**
   * OWNERSHIP IS PART OF THE WHERE CLAUSE, not a check before it.
   *
   * Reading the row, comparing its `wawuUserId` and then updating by id is
   * the shape that leaks: between the read and the write the row can move,
   * and a mistake in the comparison is one missing `!` away from letting
   * anybody edit anybody's history. `updateMany` with both keys cannot be
   * wrong that way, and a count of 0 is the 404.
   */
  async update(
    wawuUserId: string,
    id: string,
    dto: UpdateProfileExperienceDto,
  ): Promise<ProfileExperienceView> {
    const current = await this.prisma.profileExperience.findFirst({
      where: { id, wawuUserId },
    });
    if (!current) throw new NotFoundException('Experience not found');

    // Compared against what the row WILL hold, not against the patch alone.
    const startedOn =
      dto.startedOn !== undefined
        ? this.monthToDate(dto.startedOn)
        : current.startedOn;
    const endedOn =
      dto.endedOn === undefined
        ? current.endedOn
        : dto.endedOn === null
          ? null
          : this.monthToDate(dto.endedOn);
    this.assertOrdered(startedOn, endedOn);

    const written = await this.prisma.profileExperience.updateMany({
      where: { id, wawuUserId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.company !== undefined ? { company: dto.company } : {}),
        ...(dto.location !== undefined
          ? { location: dto.location ?? null }
          : {}),
        ...(dto.startedOn !== undefined ? { startedOn } : {}),
        ...(dto.endedOn !== undefined ? { endedOn } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description ?? null }
          : {}),
      },
    });
    if (written.count === 0)
      throw new NotFoundException('Experience not found');

    const row = await this.prisma.profileExperience.findFirstOrThrow({
      where: { id, wawuUserId },
    });
    return this.toView(row);
  }

  /** Same ownership reasoning as `update`: both keys, or nothing. */
  async remove(wawuUserId: string, id: string): Promise<{ deleted: true }> {
    const written = await this.prisma.profileExperience.deleteMany({
      where: { id, wawuUserId },
    });
    if (written.count === 0)
      throw new NotFoundException('Experience not found');
    return { deleted: true };
  }
}
