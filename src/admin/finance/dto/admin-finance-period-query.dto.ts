import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, Validate } from 'class-validator';
import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * A `?from=&to=` window, shared by every endpoint on this surface.
 *
 * Both bounds are optional and both are ISO 8601. `from` is INCLUSIVE and
 * `to` is EXCLUSIVE, which is the only pair of conventions under which two
 * adjacent months cannot double-count a transaction that lands on midnight.
 * The resolved window is echoed back on every response so a screen never has
 * to guess which one it got.
 *
 * With neither bound, the period is the current calendar month in UTC.
 */
@ValidatorConstraint({ name: 'financePeriodIsOrdered', async: false })
export class FinancePeriodIsOrderedConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as AdminFinancePeriodQueryDto;
    if (typeof value !== 'string' || !dto.from) return true;
    const from = Date.parse(dto.from);
    const to = Date.parse(value);
    if (Number.isNaN(from) || Number.isNaN(to)) return true;
    return to > from;
  }

  defaultMessage(): string {
    return '`to` has to be after `from`. The window is [from, to) - inclusive at the start, exclusive at the end.';
  }
}

export class AdminFinancePeriodQueryDto {
  /** Inclusive lower bound. Omitted with `to` means the current calendar month. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Exclusive upper bound. Omitted with `from` means the current calendar month. */
  @IsOptional()
  @IsISO8601()
  @Validate(FinancePeriodIsOrderedConstraint)
  to?: string;
}

/**
 * Splits `?stream=content,tips` and `?stream=content&stream=tips` into the
 * same array, so a dashboard can build the query either way and get the same
 * answer. A single value stays a one-element array.
 */
export const toStringArray = Transform(({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parts = raw
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return parts.length > 0 ? parts : undefined;
});
