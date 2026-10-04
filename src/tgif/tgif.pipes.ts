import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { TGIF_CARDS, type TgifCard } from './tgif.constants';

const DAY_MS = 86_400_000;
/** The first day TGIF could have existed on this service. */
const EARLIEST = Date.UTC(2020, 0, 1);

/** The UTC calendar day of `now`, as a Date at 00:00 UTC. */
export function utcToday(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * A `:date` path segment: `YYYY-MM-DD`, a real calendar day (2026-02-30 is
 * refused, not rolled into March), and handed on as written (the service turns it into the day the DATE
 * column holds). Reading accepts any day from 2020-01-01 to tomorrow (UTC). Writing
 * accepts only yesterday, today and tomorrow (UTC): a phone's calendar day is
 * at most a day either side of UTC, and nobody can seed counts for any other
 * day.
 */
@Injectable()
export class TgifDatePipe implements PipeTransform<string, string> {
  constructor(private readonly mode: 'read' | 'write' = 'read') {}

  transform(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException('date must be a day written YYYY-MM-DD');
    }
    const [y, m, d] = value.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    if (
      at.getUTCFullYear() !== y ||
      at.getUTCMonth() !== m - 1 ||
      at.getUTCDate() !== d
    ) {
      throw new BadRequestException('date is not a real calendar day');
    }
    const today = utcToday().getTime();
    const latest = today + DAY_MS;
    const earliest = this.mode === 'write' ? today - DAY_MS : EARLIEST;
    if (at.getTime() < earliest || at.getTime() > latest) {
      throw new BadRequestException(
        this.mode === 'write'
          ? 'date must be yesterday, today or tomorrow'
          : 'date is outside the days TGIF serves',
      );
    }
    return value;
  }
}

/** A `:card` path segment: one of the five slugs, exactly. */
@Injectable()
export class TgifCardPipe implements PipeTransform<string, TgifCard> {
  transform(value: unknown): TgifCard {
    if (
      typeof value !== 'string' ||
      !(TGIF_CARDS as readonly string[]).includes(value)
    ) {
      throw new BadRequestException(
        `card must be one of ${TGIF_CARDS.join(', ')}`,
      );
    }
    return value as TgifCard;
  }
}
