import { HttpException } from '@nestjs/common';
import type { MoneyErrorCode } from './dto/money-enums';
import type { MoneyErrorReason } from './dto/money-error.dto';
import { MONEY_ERROR_STATUS } from './money-contract';

/** The detail fields a refusal may carry beside its code and message. */
export type MoneyErrorDetail = Omit<MoneyErrorReason, 'code' | 'message'>;

/**
 * A refusal from a served money route, in the contract's one error shape
 * (docs/contract/CONVENTIONS.md section 3): `{ statusCode, message, data:
 * null, reason: { code, message, ...detail } }`. AllExceptionsFilter carries
 * `reason` through untouched and does not log an HttpException, so nothing a
 * refusal says reaches a log. The HTTP status comes from MONEY_ERROR_STATUS,
 * never from the thrower, so a code cannot drift from its status.
 *
 * `message` is a sentence the app may show as it is: no em-dash, no provider
 * name, and never anything the caller sent (a PIN, a code).
 */
export class MoneyError extends HttpException {
  readonly code: MoneyErrorCode;

  constructor(
    code: MoneyErrorCode,
    message: string,
    detail: MoneyErrorDetail = {},
  ) {
    super(
      { message, reason: { code, message, ...detail } },
      MONEY_ERROR_STATUS[code],
    );
    this.code = code;
  }
}
