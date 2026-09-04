import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountPurgeService } from './account-purge.service';
import { WAWU_ID_ACCOUNT_GATEWAY, type WawuIdAccountGateway } from '../account/wawu-id-account.gateway';

/**
 * REMOVES CREATOR ACCOUNTS THAT NEVER PAID.
 *
 * Product owner's instruction (4 Sep 2026): a creator who does not pay has
 * their data deleted within two days. Signing up as a creator is the start of
 * a purchase, and an unpaid one leaves a name, an email and a phone number
 * sitting in the database indefinitely for an account that can do nothing.
 *
 * The shape of it:
 *   at 24h   one warning email, saying what closes and when, with the one
 *            action that stops it
 *   at 48h   every row purged here, then the identity anonymized at WAWU ID
 *
 * WHAT IT WILL NOT TOUCH, and why each of these is deliberate:
 *
 *  - A plain USER account. They have nothing to pay for. Deleting readers for
 *    not buying a creator plan would empty the platform.
 *  - A creator who has EVER paid. The check is on the subscription row, not
 *    on whether it is currently active: someone whose plan lapsed is a
 *    customer with published work and buyers, not an abandoned signup.
 *  - An account that has not been warned. If the warning could not be sent,
 *    the clock does not start. Deleting someone who was never told, because
 *    our own mail call failed, is the one outcome worth failing safe over.
 *  - Anything, at all, unless UNPAID_ACCOUNT_REAPER=on. This deletes real
 *    accounts irreversibly; it does not run because a service booted.
 */
@Injectable()
export class UnpaidAccountReaperService {
  private readonly logger = new Logger(UnpaidAccountReaperService.name);

  /** Warn a day in, delete a day after that. */
  private static readonly WARN_AFTER_MS = 24 * 60 * 60 * 1000;
  private static readonly DELETE_AFTER_MS = 48 * 60 * 60 * 1000;
  /** A ceiling per run, so a misconfiguration cannot empty the table in one pass. */
  private static readonly MAX_PER_RUN = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly purge: AccountPurgeService,
    private readonly config: ConfigService,
    @Inject(WAWU_ID_ACCOUNT_GATEWAY) private readonly wawuId: WawuIdAccountGateway,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>('UNPAID_ACCOUNT_REAPER') === 'on';
  }

  private get planUrl(): string {
    const web = this.config.get<string>('WEB_BASE_URL') ?? 'https://wawuafrica.com';
    return `${web.replace(/\/$/, '')}/onboarding`;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'reap-unpaid-accounts' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    await this.warn();
    await this.remove();
  }

  /**
   * Creator accounts a day old that never paid and have not been warned.
   *
   * The warning is stamped only when the email actually went out. A stamp
   * written first, "so we do not warn twice", would start a deletion clock
   * for somebody who was never contacted.
   */
  private async warn(): Promise<void> {
    const due = await this.candidates(UnpaidAccountReaperService.WARN_AFTER_MS, { warned: false });

    for (const wawuUserId of due) {
      try {
        const { emailed } = await this.sendWarning(wawuUserId);
        if (!emailed) {
          this.logger.warn(`No address to warn ${wawuUserId} on — not starting its deletion clock`);
          continue;
        }
        await this.prisma.userProfile.updateMany({
          where: { wawuUserId, unpaidWarnedAt: null },
          data: { unpaidWarnedAt: new Date() },
        });
        this.logger.log(`Warned ${wawuUserId}: unpaid creator account closes in 24 hours`);
      } catch (e) {
        this.logger.error(`Could not warn ${wawuUserId}: ${(e as Error).message}`);
      }
    }
  }

  /** Two days old, never paid, and warned at least a day ago. */
  private async remove(): Promise<void> {
    const due = await this.candidates(UnpaidAccountReaperService.DELETE_AFTER_MS, { warned: true });

    for (const wawuUserId of due) {
      try {
        const { total } = await this.purge.purge(wawuUserId);
        await this.wawuId.scheduleAccountDeletion(wawuUserId);
        this.logger.log(`Removed unpaid creator account ${wawuUserId} (${total} rows)`);
      } catch (e) {
        // The hub rows may already be gone. Leaving the identity behind is
        // the failure worth shouting about, and the next run retries it.
        this.logger.error(`Could not finish removing ${wawuUserId}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Creator profiles older than `ageMs` with no subscription row of any kind,
   * filtered by whether they have been warned.
   *
   * Two separate reads rather than one join: CreatorSubscription is keyed by
   * creatorWawuId and UserProfile by wawuUserId, with no relation declared
   * between them, so Prisma cannot express "profiles with no subscription"
   * in a single query here.
   */
  private async candidates(ageMs: number, opts: { warned: boolean }): Promise<string[]> {
    const cutoff = new Date(Date.now() - ageMs);
    const warnedFilter = opts.warned
      ? { unpaidWarnedAt: { lte: new Date(Date.now() - UnpaidAccountReaperService.WARN_AFTER_MS) } }
      : { unpaidWarnedAt: null };

    const profiles = await this.prisma.userProfile.findMany({
      where: { accountType: 'creator', createdAt: { lt: cutoff }, ...warnedFilter },
      select: { wawuUserId: true },
      take: UnpaidAccountReaperService.MAX_PER_RUN,
    });
    if (profiles.length === 0) return [];

    const ids = profiles.map((p) => p.wawuUserId);
    // EVER subscribed, not currently active. A lapsed customer is a customer.
    const subscribed = await this.prisma.creatorSubscription.findMany({
      where: { creatorWawuId: { in: ids } },
      select: { creatorWawuId: true },
    });
    const paid = new Set(subscribed.map((s) => s.creatorWawuId));

    // Belt and braces against a stale subscription table: an account the
    // gates already treat as paid is never a candidate, whatever the
    // subscription rows say.
    const entitled = await this.prisma.creatorState.findMany({
      where: { wawuUserId: { in: ids }, subscriptionPaid: true },
      select: { wawuUserId: true },
    });
    for (const e of entitled) paid.add(e.wawuUserId);

    return ids.filter((id) => !paid.has(id));
  }

  /** WAWU ID owns the address and the wording; this names the user and the deadline. */
  private async sendWarning(wawuUserId: string): Promise<{ emailed: boolean }> {
    const baseUrl = this.config.get<string>('WAWU_ID_BASE_URL') ?? 'http://localhost:4001';
    const serviceKey = this.config.get<string>('WAWU_ID_INTERNAL_SERVICE_KEY') ?? '';
    const res = await fetch(`${baseUrl}/internal/users/${wawuUserId}/unpaid-warning`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify({ hoursLeft: 24, planUrl: this.planUrl }),
    });
    if (!res.ok) throw new Error(`WAWU ID warning call failed: ${res.status}`);
    const json = (await res.json()) as { data?: { emailed?: boolean } };
    return { emailed: json.data?.emailed === true };
  }
}
