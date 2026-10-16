import { Transform } from 'class-transformer';
import {
  IsString,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import {
  checkAdText,
  checkArtworkUrl,
  normaliseAdText,
  parseUtcInstant,
} from '../ad-text';

/**
 * Text on a sponsored card: a string that is normalised (NFC, trimmed, one
 * space between words) and then must pass `checkAdText` (visible characters
 * by Unicode category, one line, no dashes, within `max`).
 */
export function AdText(
  field: string,
  max: number,
  validation?: ValidationOptions,
) {
  return function decorate(target: object, propertyKey: string): void {
    IsString(validation)(target, propertyKey);
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? normaliseAdText(value) : value,
    )(target, propertyKey);
    registerDecorator({
      name: 'adText',
      target: target.constructor,
      propertyName: propertyKey,
      options: validation,
      validator: {
        validate(value: unknown): boolean {
          return typeof value !== 'string' || checkAdText(value, field, max).ok;
        },
        defaultMessage(args: ValidationArguments): string {
          const result = checkAdText(String(args.value), field, max);
          return result.ok ? `${field} is not valid.` : result.message;
        },
      },
    });
  };
}

/** An https link to a public host that may go on a card as its picture. */
export function IsArtworkUrl(validation?: ValidationOptions) {
  return function decorate(target: object, propertyKey: string): void {
    IsString(validation)(target, propertyKey);
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    )(target, propertyKey);
    registerDecorator({
      name: 'isArtworkUrl',
      target: target.constructor,
      propertyName: propertyKey,
      options: validation,
      validator: {
        validate(value: unknown): boolean {
          return typeof value !== 'string' || checkArtworkUrl(value).ok;
        },
        defaultMessage(args: ValidationArguments): string {
          const result = checkArtworkUrl(String(args.value));
          return result.ok ? 'artworkUrl is not valid.' : result.message;
        },
      },
    });
  };
}

/**
 * An instant in UTC, ISO 8601 ending in Z (`2026-10-18T09:00:00Z`). An offset,
 * a bare date or a day that does not exist is refused, so there is one way to
 * write a time and no guess about a zone.
 */
export function IsUtcInstant(field: string, validation?: ValidationOptions) {
  return function decorate(target: object, propertyKey: string): void {
    registerDecorator({
      name: 'isUtcInstant',
      target: target.constructor,
      propertyName: propertyKey,
      options: validation,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && parseUtcInstant(value) !== null;
        },
        defaultMessage(): string {
          return `${field} must be a UTC time like 2026-10-18T09:00:00Z (ending in Z, no offset).`;
        },
      },
    });
  };
}
