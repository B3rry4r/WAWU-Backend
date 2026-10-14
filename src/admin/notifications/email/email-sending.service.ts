import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  MAX_SEND_ATTEMPTS,
  MAX_SENDS_PER_SECOND,
  RETRY_BASE_MS,
  emailFrom,
} from './email-config';
import { RequestPacer } from './email-pacer';
import {
  EmailTransport,
  ProviderMessage,
  ProviderResult,
  ResendClient,
  WawuIdMailRelay,
} from './email-provider';
import { renderEmail } from './email-render';
import { unsubscribeUrl } from './email-unsubscribe';

export interface EmailContent {
  subject: string;
  previewText: string;
  body: string;
}

/** How many recipients are worked on at once; the pacer still caps the rate. */
const WORKERS = 4;
const BATCH = 40;

export type RecipientOutcome = 'sent' | 'failed' | 'skipped' | 'not_claimed';

/**
 * The background job that sends a campaign (EMAIL-01). It runs inside the Hub,
 * a few recipients at a time, through one pacer shared by every send so the
 * provider never sees more than MAX_SENDS_PER_SECOND requests a second.
 *
 * ── NO DOUBLE SEND ───────────────────────────────────────────────────────────
 * A recipient is claimed before anything leaves: one conditional UPDATE
 * (`claimedAt` null to now, only while `queued`). Whoever gets count 1 sends;
 * every other worker, and a restart that resumes the campaign, gets 0 and
 * moves on. A row that was claimed but never got a result (the server died
 * mid-send) is NOT sent again: it is marked failed, because a repeat could
 * reach the person twice. The provider is also given a per-recipient
 * Idempotency-Key, so a retry of one request cannot create a second email.
 */
@Injectable()
export class EmailSendingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmailSendingService.name);
  private readonly running = new Set<string>();
  /** Public so a spec can swap in a fake clock. */
  pacer = new RequestPacer(MAX_SENDS_PER_SECOND);
  retrySleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly resend: ResendClient,
    private readonly relay: WawuIdMailRelay,
  ) {}

  /**
   * Where mail goes out. WAWU ID's relay is the default; a Hub that has its own
   * RESEND_API_KEY still sends straight to Resend, from EMAIL_CAMPAIGN_FROM.
   */
  private transport(): EmailTransport {
    return this.resend.apiKey() ? this.resend : this.relay;
  }

  /** A campaign that was mid-send when the server stopped carries on. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.missingSetting()) {
      const open = await this.prisma.emailCampaign
        .findMany({ where: { status: 'sending' }, select: { id: true } })
        .catch(() => []);
      for (const c of open) this.startRun(c.id);
    }
  }

  /** The plain sentence for a 409 when a setting is missing, or null. */
  missingSetting(): string | null {
    if (!this.resend.apiKey() && !this.relay.configured()) {
      return 'No email sender is set up on the server. Email goes out through WAWU ID, which needs WAWU_ID_BASE_URL and WAWU_ID_INTERNAL_SERVICE_KEY to be set here, so no email can be sent.';
    }
    if (
      !this.config.get<string>('HUB_PUBLIC_URL') &&
      process.env.NODE_ENV === 'production'
    ) {
      return 'HUB_PUBLIC_URL is not set on the server, so the unsubscribe link has no address.';
    }
    return null;
  }

  private hubBase(): string {
    const set = this.config.get<string>('HUB_PUBLIC_URL');
    if (set) return set.replace(/\/+$/, '');
    return `http://localhost:${process.env.HUB_API_PORT ?? 3001}`;
  }

  buildMessage(
    content: EmailContent,
    to: { id: string; email: string; firstName: string | null },
    subjectPrefix = '',
    tag?: string,
  ): ProviderMessage {
    const link = unsubscribeUrl(
      this.hubBase(),
      to.email,
      this.config.get<string>('ADMIN_JWT_SECRET'),
    );
    const mail = renderEmail({
      subject: content.subject,
      previewText: content.previewText,
      body: content.body,
      firstName: to.firstName,
      unsubscribeUrl: link,
    });
    return {
      from: emailFrom(this.config),
      to: to.email,
      subject: `${subjectPrefix}${mail.subject}`,
      html: mail.html,
      text: mail.text,
      headers: {
        'List-Unsubscribe': `<${link}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      idempotencyKey: `wawu-email-${to.id}`,
      ...(tag ? { tag } : {}),
    };
  }

  /** One message, paced, with retries for transient failures. */
  async sendWithRetries(message: ProviderMessage): Promise<ProviderResult> {
    let last: ProviderResult = {
      ok: false,
      transient: false,
      error: 'Not attempted.',
    };
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      await this.pacer.acquire();
      last = await this.transport().send(message);
      if (last.ok || !last.transient) return last;
      if (attempt < MAX_SEND_ATTEMPTS) {
        await this.retrySleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    return last;
  }

  /** Begin (or carry on) sending a campaign in the background. */
  startRun(campaignId: string): void {
    if (this.running.has(campaignId)) return;
    this.running.add(campaignId);
    void this.run(campaignId)
      .catch((e: unknown) =>
        this.logger.error(
          `Campaign ${campaignId} stopped: ${e instanceof Error ? e.message : 'error'}`,
        ),
      )
      .finally(() => this.running.delete(campaignId));
  }

  async run(campaignId: string): Promise<void> {
    // A row claimed with no result belongs to a run that died: never resend it.
    await this.prisma.emailRecipient.updateMany({
      where: { campaignId, status: 'queued', claimedAt: { not: null } },
      data: {
        status: 'failed',
        error:
          'Interrupted before a result was recorded. Not sent again, to avoid a double send.',
      },
    });
    for (;;) {
      const batch = await this.prisma.emailRecipient.findMany({
        where: { campaignId, status: 'queued', claimedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
        select: { id: true },
      });
      if (batch.length === 0) break;
      const ids = batch.map((r) => r.id);
      await Promise.all(
        Array.from({ length: Math.min(WORKERS, ids.length) }, async () => {
          for (let id = ids.shift(); id !== undefined; id = ids.shift()) {
            await this.processRecipient(campaignId, id);
          }
        }),
      );
    }
    await this.finish(campaignId);
  }

  /**
   * Claim, check, send, record. Returns `not_claimed` when another worker (or
   * an earlier run) already took this recipient, and then sends nothing.
   */
  async processRecipient(
    campaignId: string,
    recipientId: string,
  ): Promise<RecipientOutcome> {
    const claim = await this.prisma.emailRecipient.updateMany({
      where: { id: recipientId, campaignId, status: 'queued', claimedAt: null },
      data: { claimedAt: new Date() },
    });
    if (claim.count !== 1) return 'not_claimed';

    const recipient = await this.prisma.emailRecipient.findUniqueOrThrow({
      where: { id: recipientId },
      include: { campaign: true },
    });
    const bump = (field: 'sentCount' | 'failedCount' | 'skippedCount') =>
      this.prisma.emailCampaign.update({
        where: { id: campaignId },
        data: { [field]: { increment: 1 } },
      });

    const suppressed = await this.prisma.emailSuppression.findUnique({
      where: { email: recipient.email },
    });
    if (suppressed) {
      await this.prisma.emailRecipient.update({
        where: { id: recipientId },
        data: { status: 'skipped', error: 'unsubscribed' },
      });
      await bump('skippedCount');
      return 'skipped';
    }

    const result = await this.sendWithRetries(
      this.buildMessage(recipient.campaign, recipient, '', campaignId),
    );
    if (result.ok) {
      await this.prisma.emailRecipient.update({
        where: { id: recipientId },
        data: {
          status: 'sent',
          providerId: result.id,
          sentAt: new Date(),
          error: null,
        },
      });
      await bump('sentCount');
      return 'sent';
    }
    await this.prisma.emailRecipient.update({
      where: { id: recipientId },
      data: { status: 'failed', error: result.error },
    });
    await bump('failedCount');
    return 'failed';
  }

  private async finish(campaignId: string): Promise<void> {
    const groups = await this.prisma.emailRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });
    const n = (s: string) =>
      groups.find((g) => g.status === s)?._count._all ?? 0;
    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        status: 'sent',
        finishedAt: new Date(),
        totalCount: groups.reduce((a, g) => a + g._count._all, 0),
        sentCount: n('sent'),
        failedCount: n('failed'),
        skippedCount: n('skipped'),
      },
    });
  }
}
