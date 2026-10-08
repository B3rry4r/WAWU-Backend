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
 * The request-body refusals that are the caller's fault (task FIX-08).
 *
 * Nest installs Express's `json()` and `urlencoded()` parsers (body-parser,
 * which reads through raw-body) in front of every route, with their default
 * 100 kB limit; this filter does not change that. When one of them refuses a
 * body it hands Express an `http-errors` error carrying the right status:
 * 413 too large or too many fields, 415 a charset or content encoding it
 * cannot read, 400 a body it could not read (a broken gzip stream, a form
 * nested too deep, a length that does not match). Left unmapped those became
 * 500s, which tells the caller to retry something that can never work.
 *
 * Only these three statuses are mapped. Nest itself already turns malformed
 * JSON (a SyntaxError) into a 400 HttpException before this filter sees it,
 * so that answer, with the parser's own message, is unchanged. Anything else
 * that merely looks like an http-errors error (another status, or one not
 * marked `expose`, which http-errors sets only on 4xx) stays a 500 as before.
 *
 * The parser's own text is not sent: it is lower case and echoes the
 * caller's header values. Each status gets a plain sentence instead.
 */
const BODY_PARSER_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.BAD_REQUEST,
  HttpStatus.PAYLOAD_TOO_LARGE,
  HttpStatus.UNSUPPORTED_MEDIA_TYPE,
]);

/** By body-parser's `type`, where one status covers more than one cause. */
const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.too.large': 'That request is too large.',
  'parameters.too.many': 'That request has too many fields.',
  'charset.unsupported':
    'That request uses a character set this server does not read. Send it as UTF-8.',
  'encoding.unsupported':
    'That request uses a content encoding this server does not read.',
};

/** When the error carries no `type` this filter knows. */
const BODY_PARSER_FALLBACK_MESSAGES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'That request could not be read.',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'That request is too large.',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]:
    'That request is in a format this server does not read.',
};

/**
 * Structural check for an `http-errors` client error, the same way
 * prismaErrorCode avoids importing Prisma's classes: `status` and
 * `statusCode` both set to the same number, and `expose` true.
 */
function bodyParserRefusal(
  exception: unknown,
): { statusCode: number; message: string } | undefined {
  if (!(exception instanceof Error)) return undefined;
  const candidate = exception as Error & {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
    type?: unknown;
  };
  const status = candidate.status;
  if (
    typeof status !== 'number' ||
    status !== candidate.statusCode ||
    candidate.expose !== true ||
    !BODY_PARSER_STATUSES.has(status)
  ) {
    return undefined;
  }
  const byType =
    typeof candidate.type === 'string'
      ? BODY_PARSER_MESSAGES[candidate.type]
      : undefined;
  return {
    statusCode: status,
    message: byType ?? BODY_PARSER_FALLBACK_MESSAGES[status],
  };
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
      const refused = bodyParserRefusal(exception);
      const mapped = PRISMA_ERROR_MAP[prismaErrorCode(exception) ?? ''];
      if (refused) {
        // The caller's mistake, answered like any other 4xx: not logged.
        statusCode = refused.statusCode;
        message = refused.message;
      } else if (mapped) {
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
