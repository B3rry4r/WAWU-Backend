import { Injectable, Logger } from '@nestjs/common';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { WawuIdMailRelay } from '../../admin/notifications/email/email-provider';
import type { OpenWallet } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import { StatementQueryDto } from './statement-query.dto';
import {
  mailIdempotencyKey,
  maskedEmail,
  provenEmailOf,
  statementMail,
} from './statement-email';
import type {
  StatementDeliveryView,
  StatementEmailView,
} from './statement-email-view.type';
import { STATEMENT_EMAIL_MAX_BYTES } from './statement-config';
import { STATEMENT_FORMATS } from './statement-view.type';
import { StatementService } from './statement.service';

export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Confirm your email address to get a statement by email.';
export const STATEMENT_EMAIL_FAILED_MESSAGE =
  "We couldn't send your statement. Try again in a moment.";
export const STATEMENT_EMAIL_TOO_BIG_MESSAGE =
  'This statement is too big to send by email. Pick a shorter range.';

/**
 * Emailing a statement (task WALLET-35, W38). The statement is built by
 * StatementService exactly as `GET /money/statements` builds it (the same
 * period rules, the same rows), then handed to WAWU ID's mail relay
 * (`POST /internal/mail/send`, EMAIL-02) as a CSV attachment. WAWU ID owns
 * the sender and the provider key; the Hub holds no address of its own, so
 * the destination is the signed-in person's own confirmed address from their
 * token, never one from the request.
 */
@Injectable()
export class StatementEmailService {
  private readonly logger = new Logger(StatementEmailService.name);

  constructor(
    private readonly statements: StatementService,
    private readonly relay: WawuIdMailRelay,
  ) {}

  delivery(claims: WawuJwtClaims): StatementDeliveryView {
    const email = provenEmailOf(claims);
    return {
      email: email ? maskedEmail(email) : null,
      canEmail: email !== null,
      formats: [...STATEMENT_FORMATS],
    };
  }

  /** The address a statement goes to, or the 409 that says to confirm one. */
  addressFor(claims: WawuJwtClaims): string {
    const email = provenEmailOf(claims);
    if (!email) {
      throw new MoneyError('email_not_verified', EMAIL_NOT_VERIFIED_MESSAGE);
    }
    return email;
  }

  async send(
    wallet: Pick<OpenWallet, 'wawuUserId' | 'accountNumber'>,
    to: string,
    query: StatementQueryDto,
    clientKey: string | undefined,
  ): Promise<StatementEmailView> {
    const view = await this.statements.statement(wallet, query);
    // The relay refuses a file past its cap with a 400 that can never succeed,
    // which the person would see as "try again". Say it now, as a final answer.
    if (Buffer.byteLength(view.content, 'utf8') > STATEMENT_EMAIL_MAX_BYTES) {
      throw new MoneyError(
        'statement_too_large',
        STATEMENT_EMAIL_TOO_BIG_MESSAGE,
      );
    }
    const mail = statementMail(view);
    const result = await this.relay.send({
      from: '',
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: {},
      idempotencyKey: mailIdempotencyKey(wallet.wawuUserId, clientKey),
      attachments: [
        {
          filename: view.fileName,
          content: Buffer.from(view.content, 'utf8').toString('base64'),
          contentType: view.contentType,
        },
      ],
    });
    if (!result.ok) {
      // The address is never logged, only what went wrong.
      this.logger.warn(
        `Statement email for ${wallet.wawuUserId} not sent (${result.transient ? 'transient' : 'refused'}): ${result.error}`,
      );
      throw new MoneyError(
        'statement_email_failed',
        STATEMENT_EMAIL_FAILED_MESSAGE,
      );
    }
    return {
      sentTo: maskedEmail(to),
      from: view.from,
      to: view.to,
      format: view.format,
      fileName: view.fileName,
      rowCount: view.rowCount,
      sentAt: new Date().toISOString(),
    };
  }
}
