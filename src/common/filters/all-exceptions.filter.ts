import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Known-request errors Prisma raises with a stable `code`. Left unmapped
 * these surfaced as 500s, which is wrong on both counts: a duplicate insert
 * (double-tapped follow, replayed payment verify) and an update/delete
 * against a row that isn't there are caller-visible conditions, not server
 * faults, and a 500 tells the client to retry something that can never work.
 *
 * The mapped message is deliberately generic — Prisma's `meta` names the
 * constraint and the table, and none of that goes on the wire.
 */
const PRISMA_ERROR_MAP: Record<
  string,
  { statusCode: HttpStatus; message: string }
> = {
  /** Unique constraint violation. */
  P2002: {
    statusCode: HttpStatus.CONFLICT,
    message: 'That record already exists.',
  },
  /** "Depends on one or more records that were required but not found." */
  P2025: {
    statusCode: HttpStatus.NOT_FOUND,
    message: 'Not found.',
  },
};

/**
 * Structural check, so this global filter doesn't have to import the
 * generated Prisma error classes (which would couple `src/common` to a
 * generated path and break if the client is regenerated elsewhere).
 */
function prismaErrorCode(exception: unknown): string | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const candidate = exception as {
    name?: unknown;
    code?: unknown;
    clientVersion?: unknown;
  };
  if (typeof candidate.code !== 'string' || !/^P\d{4}$/.test(candidate.code)) {
    return undefined;
  }
  const looksPrisma =
    (typeof candidate.name === 'string' &&
      candidate.name.startsWith('Prisma')) ||
    typeof candidate.clientVersion === 'string';
  return looksPrisma ? candidate.code : undefined;
}

/**
 * Single production point for the error envelope (conventions.md § Error
 * envelope). No controller/service ever hand-rolls an error response shape.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Something went wrong. Please try again.';
    /**
     * A refusal that explains itself.
     *
     * A bare 403 with a sentence in it tells a screen that something is not
     * allowed and nothing about what would make it allowed, so the screen
     * guesses, and a guessed remedy is usually a dead end. When a thrower
     * puts a `reason` object on the exception body it is carried through to
     * the caller untouched, so the app can render "here is what you need to
     * do" instead of a wall.
     *
     * Additive: an exception without one produces exactly the envelope this
     * filter has always produced, with no extra key.
     */
    let reason: unknown;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const maybeMessage = (body as { message?: string | string[] }).message;
        message = Array.isArray(maybeMessage)
          ? maybeMessage[0]
          : (maybeMessage ?? exception.message);
        reason = (body as { reason?: unknown }).reason;
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Error) {
      const mapped = PRISMA_ERROR_MAP[prismaErrorCode(exception) ?? ''];
      if (mapped) {
        statusCode = mapped.statusCode;
        message = mapped.message;
        // Still logged: a P2002/P2025 reaching this filter means a service
        // didn't pre-check, which is worth seeing in the logs even though
        // the caller now gets a correct 4xx.
        this.logger.warn(
          `${exception.name} ${prismaErrorCode(exception)}: ${exception.message}`,
        );
      } else {
        this.logger.error(exception.message, exception.stack);
      }
    } else {
      this.logger.error('Unknown exception thrown', String(exception));
    }

    response.status(statusCode).json({
      statusCode,
      message,
      data: null,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}
