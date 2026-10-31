import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WawuIdMailRelay } from '../admin/notifications/email/email-provider';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  UGC_KIND_LABELS,
  UGC_REASON_LABELS,
  UGC_SUPPORT_EMAIL,
  type UgcKind,
  type UgcReason,
} from './ugc-report.kinds';

/** A busy relay is asked this many times in all, with a growing wait (500 ms, then double). */
const ATTEMPTS = 3;
const RETRY_BASE_MS = Number(process.env.UGC_REPORT_MAIL_RETRY_MS ?? 500);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ReportMailFacts {
  id: string;
  kind: UgcKind;
  targetId: string;
  reason: UgcReason;
  note: string | null;
  reporterWawuId: string;
  subjectWawuId: string;
  /** A short piece of the item itself (a title or the first words), already cut. */
  preview: string;
}

/**
 * Mails support@wawuafrica.com for each NEW report (REPORT-UGC), through the Hub's existing path to WAWU ID's mail relay
 * (`WawuIdMailRelay`, `POST /internal/mail/send`; WAWU ID owns the sender and the provider key). It never throws and
 * never delays the report: the report is stored first, this runs on its own, and `emailedAt` is set when WAWU ID took
 * the mail. A relay that stays down leaves `emailedAt` empty and the report in the admin list, which is the source of
 * truth. A repeat report sends nothing.
 */
@Injectable()
export class UgcReportMailService {
  private readonly logger = new Logger(UgcReportMailService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly relay: WawuIdMailRelay,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  recipient(): string {
    return (
      this.config.get<string>('UGC_REPORT_MAIL_TO')?.trim() || UGC_SUPPORT_EMAIL
    );
  }

  /** Raises the mail and returns at once. */
  notify(facts: ReportMailFacts): void {
    const p = this.deliver(facts).catch((e: unknown) => {
      this.logger.error(
        `report mail ${facts.id}: failed before it was asked (${e instanceof Error ? e.name : 'error'})`,
      );
    });
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  /** Resolves when every mail raised so far has been asked (or given up). Specs and shutdown wait on it. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.race([
      this.settled(),
      new Promise<void>((r) => setTimeout(r, 5_000).unref()),
    ]);
  }

  private async deliver(f: ReportMailFacts): Promise<void> {
    const kind = UGC_KIND_LABELS[f.kind];
    const reason = UGC_REASON_LABELS[f.reason];
    const lines = [
      `A new report: ${kind}, ${reason}.`,
      '',
      `Report: ${f.id}`,
      `What: ${kind} ${f.targetId}`,
      `Reported person: ${f.subjectWawuId}`,
      `Reported by: ${f.reporterWawuId}`,
      `Reason: ${reason}`,
      ...(f.note ? [`Note: ${f.note}`] : []),
      ...(f.preview ? [`Item: ${f.preview}`] : []),
      '',
      'Open it in the admin Reports list to dismiss it or take the item down.',
    ];
    const text = lines.join('\n');
    const html = `<p>${lines.map(escapeHtml).join('<br>')}</p>`;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const result = await this.relay.send({
        from: '',
        to: this.recipient(),
        subject: `Report: ${kind} (${reason})`,
        html,
        text,
        headers: {},
        idempotencyKey: `ugc-report-${f.id}`,
      });
      if (result.ok) {
        await this.prisma.ugcReport.updateMany({
          where: { id: f.id, emailedAt: null },
          data: { emailedAt: new Date() },
        });
        return;
      }
      this.logger.warn(
        `report mail ${f.id}: not sent (${result.transient ? 'busy' : 'refused'}): ${result.error}`,
      );
      if (!result.transient || attempt === ATTEMPTS) return;
      await new Promise((r) =>
        setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)),
      );
    }
  }
}
