import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * A write body must be a JSON object. The global ValidationPipe lets an empty
 * array through an all-optional DTO, and the service would spread it into the
 * Prisma `data` (a 500). This answers 400 for an array, a number, a string or
 * `null`. It runs after the global pipe, on the transformed value.
 */
@Injectable()
export class PlainObjectBodyPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException('the body must be a JSON object');
    }
    return value;
  }
}
