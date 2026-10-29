import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  relayBaseUrl,
  relayServiceKey,
} from '../admin/notifications/email/email-config';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  cleanNoticeData,
  type NoticeData,
  type NoticeKind,
} from './notice-kinds';

/** The admin switch for every money and account email (default 1, on). */
export const MONEY_EMAILS_SWITCH = 'notifications.money_emails_on';

/** One call to WAWU ID is waited for this long. */
export const NOTICE_TIMEOUT_MS = 10_000;
/** A busy relay is asked this many times in all. */
export const NOTICE_MAX_ATTEMPTS = 3;
/** First wait before a retry; it doubles. `NOTICE_MAIL_RETRY_MS` overrides it (tests). */
export const NOTICE_RETRY_BASE_MS = 500;

const KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The idempotency key of one notice: the kind and the event's own id(s). Two
 * sightings of one event (a replay, a sweep and a webhook, two servers) give
 * the same key, so WAWU ID sends it once. Characters WAWU ID does not accept
 * become `_`; a key that would be too long is shortened with a hash of it.
 */
export function noticeKey(
  kind: NoticeKind,
  ...parts: Array<string | number | bigint>
): string {
  const raw = [kind, ...parts.map(String)]
    .join('-')
    .replace(/[^A-Za-z0-9_-]/g, '_');
  if (raw.length <= 128) return raw.length >= 8 ? raw : raw.padEnd(8, '_');
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  return `${raw.slice(0, 100)}-${hash}`;
}

interface PendingNotice {
  wawuId: string;
  kind: NoticeKind;
  data: unknown;
  key: string;
}

interface Scope {
  pending: Array<() => Promise<void>>;
  /** Set once the scope has been flushed: a late notice is then sent at once. */
  closed: boolean;
}

type Attempt = { done: true } | { done: false; retry: boolean; why: string };

/**
 * Asks WAWU ID to email a person a money or account notice (EMAIL-02).
 *
 * `POST {WAWU_ID_BASE_URL}/internal/mail/notice` with
 * `{ wawuId, kind, data, idempotencyKey }` and the shared service key. The
 * Hub sends a person's id and plain facts, never an address and never HTML:
 * WAWU ID finds the address, writes the words and sends once per key (a repeat
 * answers `{ sent: false, replayed: true }`), and skips a person with no
 * proven email.
 *
 * Rules every caller relies on:
 * - It runs AFTER the money event has committed, never inside its
 *   transaction. A site inside a transaction wraps the transaction in
 *   `within()`: notices raised inside are held, sent when the whole thing
 *   commits and dropped when it rolls back or throws.
 * - It never throws and never delays the money path: `notify()` returns at
 *   once and the call, with its retries, runs on its own. A caller that must
 *   have the mail asked before it goes on (the account is about to be
 *   anonymised) awaits `notifyNow()`.
 * - A busy relay (a network error, a timeout, any 5xx) is asked again, up to
 *   three times with a growing wait. A 400 (or any other refusal: the key, the
 *   daily cap) is not asked again. After the last try the failure is logged by
 *   kind and key only; the money event is untouched.
 * - The `notifications.money_emails_on` setting (default 1) stops all of them.
 * - Facts that do not fit the kind's fields exactly are refused here and not
 *   sent (cleanNoticeData), so no address and no markup can leave.
 */
@Injectable()
export class NoticeMailer {
  private readonly logger = new Logger(NoticeMailer.name);
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly inFlight = new Set<Promise<void>>();
  private warnedUnset = false;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: PlanSettingsService,
  ) {}

  /**
   * Runs `work` (a transaction, or a call that opens one). Notices raised
   * inside are sent after it returns and dropped if it throws. Nested calls
   * join the outer scope, so nothing is sent while an outer transaction is
   * still open.
   */
  async within<T>(work: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return work();
    const scope: Scope = { pending: [], closed: false };
    try {
      const result = await this.scope.run(scope, work);
      scope.closed = true;
      for (const run of scope.pending) void this.track(run);
      return result;
    } finally {
      scope.closed = true;
    }
  }

  /**
   * Runs `work` once the money event is committed: at once when called
   * outside `within()`, when the scope returns inside it, never if the scope
   * throws. `work` may read the database and ask for names (it holds no
   * transaction); it must not throw, and whatever it throws is logged by name.
   * Returns at once.
   */
  later(work: () => Promise<void>): void {
    const scope = this.scope.getStore();
    if (scope && !scope.closed) {
      scope.pending.push(work);
      return;
    }
    void this.track(work);
  }

  /** Raises a notice. Returns at once. Inside `within()` it waits for the commit. */
  notify<K extends NoticeKind>(
    wawuId: string,
    kind: K,
    data: NoticeData[K],
    key: string,
  ): void {
    this.later(() => this.deliver({ wawuId, kind, data, key }));
  }

  /** Raises a notice and waits until it has been asked, with its retries. Never throws. */
  async notifyNow<K extends NoticeKind>(
    wawuId: string,
    kind: K,
    data: NoticeData[K],
    key: string,
  ): Promise<void> {
    const scope = this.scope.getStore();
    const work = () => this.deliver({ wawuId, kind, data, key });
    if (scope && !scope.closed) {
      scope.pending.push(work);
      return;
    }
    await this.track(work);
  }

  /** Resolves when every notice raised so far has been asked (or given up). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.race([
      this.settled(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
  }

  private track(work: () => Promise<void>): Promise<void> {
    const p = work().catch((e: unknown) => {
      // A notice does not throw; this keeps a bug from becoming an unhandled rejection.
      this.logger.error(
        `notice: failed before it was asked (${e instanceof Error ? e.name : 'error'})`,
      );
    });
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  private switchedOn(): boolean {
    try {
      return this.settings.number(MONEY_EMAILS_SWITCH) !== 0;
    } catch {
      // Unreadable: the setting's own default (on) stands.
      return true;
    }
  }

  private async deliver(n: PendingNotice): Promise<void> {
    if (!this.switchedOn()) return;
    if (!KEY_SHAPE.test(n.key) || n.wawuId.trim() === '') {
      this.logger.error(
        `notice ${n.kind} ${n.key}: not sent (bad key or person)`,
      );
      return;
    }
    const data = cleanNoticeData(n.kind, n.data);
    if (data === null) {
      this.logger.error(
        `notice ${n.kind} ${n.key}: not sent (the facts do not fit the kind)`,
      );
      return;
    }
    const base = relayBaseUrl(this.config);
    const serviceKey = relayServiceKey(this.config);
    if (!base || !serviceKey) {
      if (!this.warnedUnset) {
        this.warnedUnset = true;
        this.logger.warn(
          'money emails: WAWU ID is not set up as the email sender on this server; none are sent',
        );
      }
      return;
    }
    const body = JSON.stringify({
      wawuId: n.wawuId,
      kind: n.kind,
      data,
      idempotencyKey: n.key,
    });
    const retryMs = Number(
      this.config.get<string>('NOTICE_MAIL_RETRY_MS') ?? NOTICE_RETRY_BASE_MS,
    );
    let last = '';
    for (let attempt = 1; attempt <= NOTICE_MAX_ATTEMPTS; attempt += 1) {
      const r = await this.ask(base, serviceKey, body);
      if (r.done) return;
      last = r.why;
      if (!r.retry) break;
      if (attempt < NOTICE_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, retryMs * 2 ** (attempt - 1)),
        );
      }
    }
    // The kind and the key only: the facts and the person stay out of the log.
    this.logger.error(`notice ${n.kind} ${n.key}: not sent (${last})`);
  }

  private async ask(
    base: string,
    serviceKey: string,
    body: string,
  ): Promise<Attempt> {
    let response: Response;
    try {
      response = await fetch(`${base}/internal/mail/notice`, {
        method: 'POST',
        headers: {
          'X-Service-Key': serviceKey,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(NOTICE_TIMEOUT_MS),
      });
    } catch (e) {
      return {
        done: false,
        retry: true,
        why: `could not reach WAWU ID (${e instanceof Error ? e.name : 'error'})`,
      };
    }
    // The body is not needed: 200 and 202 are all of "asked", sent or replayed or skipped.
    try {
      await response.arrayBuffer();
    } catch {
      // Nothing to read.
    }
    if (response.status === 200 || response.status === 202) {
      return { done: true };
    }
    return {
      done: false,
      retry: response.status >= 500,
      why: `WAWU ID answered ${response.status}`,
    };
  }
}
