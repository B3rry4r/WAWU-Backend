import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Paginated } from '../../../common/interceptors/response.interceptor';
import type {
  EmailCampaignModel,
  EmailRecipientModel,
  EmailTemplateModel,
} from '../../../../generated/prisma/models';
import type { Prisma } from '../../../../generated/prisma/client';
import type { AdminUserView } from '../../auth/admin-user-view.type';
import { ConfigService } from '@nestjs/config';
import {
  MAX_CAMPAIGN_RECIPIENTS,
  VOICES_NOT_LIVE,
  brandOf,
  relayBaseUrl,
  relayServiceKey,
  voicesApi,
  type EmailBrand,
} from './email-config';
import { readMemberList, type MemberPeople } from './email-audience-source';
import {
  CsvFormatError,
  CsvPerson,
  isValidEmail,
  parseAudienceCsv,
} from './email-csv';
import { firstNameOf, planAudience } from './email-audience';
import { renderEmail } from './email-render';
import { EmailSendingService } from './email-sending.service';
import { assertButtonPair } from './dto/email.dto';
import type {
  EmailPreviewDto,
  EmailRecipientQueryDto,
  EmailTemplateDto,
  EmailTestSendDto,
  RegistrantFilter,
} from './dto/email.dto';

export interface EmailTemplateView {
  id: string;
  name: string;
  subject: string;
  previewText: string;
  body: string;
  version: number;
  updatedAt: Date;
  brand: EmailBrand;
  buttonText: string | null;
  buttonUrl: string | null;
}

export interface EmailCampaignView {
  id: string;
  templateName: string;
  subject: string;
  audienceKind: string;
  audienceNote: string;
  status: 'ready' | 'sending' | 'sent';
  totalCount: number;
  queuedCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  /** Skipped because the address had unsubscribed. */
  unsubscribedCount: number;
  invalidCount: number;
  duplicateCount: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  brand: EmailBrand;
  buttonText: string | null;
  buttonUrl: string | null;
  /** Counted from the recipients' delivery results; `sentCount` stays "accepted by the provider". */
  deliveredCount: number;
  delayedCount: number;
  bouncedCount: number;
  complainedCount: number;
  /** While a limit has paused the send: when it resumes by itself (null: only a resume restarts it). */
  pausedUntil: Date | null;
  /** Plain words saying why it is paused. */
  pauseReason: string | null;
}

export interface EmailRecipientView {
  id: string;
  email: string;
  firstName: string | null;
  status: 'queued' | 'sent' | 'failed' | 'skipped';
  error: string | null;
  sentAt: Date | null;
  delivery:
    'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | null;
  deliveryAt: Date | null;
  deliveryNote: string | null;
}

export interface EmailAudienceCountView {
  /** People matching the filter, after repeats are dropped. */
  matching: number;
  /** Who would be emailed (after unsubscribed people and the limit). */
  willSend: number;
  unsubscribed: number;
  /** The Voices and accounts lists only: false when the list cannot be read yet. */
  available?: boolean;
  /** The Voices and accounts lists only: why `available` is false. */
  reason?: string;
}

export interface EmailPreviewView {
  subject: string;
  html: string;
  text: string;
  brand: EmailBrand;
  buttonText: string | null;
  buttonUrl: string | null;
}

const templateView = (t: EmailTemplateModel): EmailTemplateView => ({
  id: t.id,
  name: t.name,
  subject: t.subject,
  previewText: t.previewText,
  body: t.body,
  version: t.version,
  updatedAt: t.updatedAt,
  brand: brandOf(t.brand),
  buttonText: t.buttonText,
  buttonUrl: t.buttonUrl,
});

const recipientView = (r: EmailRecipientModel): EmailRecipientView => ({
  id: r.id,
  email: r.email,
  firstName: r.firstName,
  status: r.status,
  error: r.error,
  sentAt: r.sentAt,
  delivery: r.delivery as EmailRecipientView['delivery'],
  deliveryAt: r.deliveryAt,
  deliveryNote: r.deliveryNote,
});

/** Preview and test-send use a made-up unsubscribe address that does nothing. */
const PREVIEW_UNSUBSCRIBE = 'https://wawuafrica.com/unsubscribe-preview';

@Injectable()
export class EmailCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sending: EmailSendingService,
    private readonly config: ConfigService,
  ) {}

  // ── templates ──────────────────────────────────────────────────────────────

  /** No brand means Who Made This only (null or 'wmt'), as the web admin has always seen. */
  async listTemplates(brand: EmailBrand = 'wmt'): Promise<EmailTemplateView[]> {
    const rows = await this.prisma.emailTemplate.findMany({
      where:
        brand === 'voices'
          ? { brand: 'voices' }
          : { OR: [{ brand: 'wmt' }, { brand: null }] },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(templateView);
  }

  async getTemplate(id: string): Promise<EmailTemplateView> {
    return templateView(await this.template(id));
  }

  async createTemplate(
    dto: EmailTemplateDto,
    admin: AdminUserView,
  ): Promise<EmailTemplateView> {
    assertButtonPair(dto.buttonText, dto.buttonUrl);
    const row = await this.prisma.emailTemplate.create({
      data: {
        ...(dto.brand ? { brand: dto.brand } : {}),
        ...(dto.buttonText ? { buttonText: dto.buttonText.trim() } : {}),
        ...(dto.buttonUrl ? { buttonUrl: dto.buttonUrl.trim() } : {}),
        name: dto.name.trim(),
        subject: dto.subject.trim(),
        previewText: dto.previewText?.trim() ?? '',
        body: dto.body,
        createdBy: admin.id,
      },
    });
    return templateView(row);
  }

  async updateTemplate(
    id: string,
    dto: EmailTemplateDto,
  ): Promise<EmailTemplateView> {
    const current = await this.template(id);
    if (dto.version !== undefined && dto.version !== current.version) {
      throw new ConflictException(
        'Someone saved this template since you opened it. Reload it and try again.',
      );
    }
    // A field left out keeps what the template has; an explicit null clears it.
    const text =
      dto.buttonText === undefined ? current.buttonText : dto.buttonText;
    const url = dto.buttonUrl === undefined ? current.buttonUrl : dto.buttonUrl;
    assertButtonPair(text, url);
    const row = await this.prisma.emailTemplate.update({
      where: { id },
      data: {
        ...(dto.brand ? { brand: dto.brand } : {}),
        ...(dto.buttonText !== undefined
          ? { buttonText: dto.buttonText?.trim() ?? null }
          : {}),
        ...(dto.buttonUrl !== undefined
          ? { buttonUrl: dto.buttonUrl?.trim() ?? null }
          : {}),
        name: dto.name.trim(),
        subject: dto.subject.trim(),
        previewText: dto.previewText?.trim() ?? '',
        body: dto.body,
        version: { increment: 1 },
      },
    });
    return templateView(row);
  }

  async deleteTemplate(id: string): Promise<{ deleted: true }> {
    await this.template(id);
    await this.prisma.emailTemplate.delete({ where: { id } });
    return { deleted: true };
  }

  private async template(id: string): Promise<EmailTemplateModel> {
    const row = await this.prisma.emailTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('That template does not exist.');
    return row;
  }

  // ── preview and test send ──────────────────────────────────────────────────

  preview(dto: EmailPreviewDto): EmailPreviewView {
    assertButtonPair(dto.buttonText, dto.buttonUrl);
    const brand = brandOf(dto.brand);
    const mail = renderEmail({
      subject: dto.subject,
      previewText: dto.previewText,
      body: dto.body,
      firstName: dto.firstName,
      unsubscribeUrl: PREVIEW_UNSUBSCRIBE,
      brand,
      button:
        dto.buttonText && dto.buttonUrl
          ? { text: dto.buttonText.trim(), url: dto.buttonUrl.trim() }
          : null,
    });
    return {
      ...mail,
      brand,
      buttonText: dto.buttonText?.trim() || null,
      buttonUrl: dto.buttonUrl?.trim() || null,
    };
  }

  async testSend(
    dto: EmailTestSendDto,
  ): Promise<{ sent: true; providerId: string }> {
    assertButtonPair(dto.buttonText, dto.buttonUrl);
    const missing = this.sending.missingSetting();
    if (missing) throw new ConflictException(missing);
    const to = dto.to.trim().toLowerCase();
    const message = this.sending.buildMessage(
      {
        subject: dto.subject,
        previewText: dto.previewText ?? '',
        body: dto.body,
        brand: dto.brand ?? null,
        buttonText: dto.buttonText?.trim() || null,
        buttonUrl: dto.buttonUrl?.trim() || null,
      },
      {
        id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        email: to,
        firstName: dto.firstName ?? null,
      },
      '[Test] ',
    );
    const result = await this.sending.sendWithRetries(message);
    if (!result.ok) {
      throw new ConflictException(
        `The test email was not sent: ${result.error}`,
      );
    }
    return { sent: true, providerId: result.id };
  }

  // ── audiences ──────────────────────────────────────────────────────────────

  private registrantWhere(
    filter: RegistrantFilter,
  ): Prisma.WaitlistRegistrationWhereInput {
    switch (filter) {
      case 'paid':
        return { status: 'paid' };
      case 'not_paid':
        return { status: { not: 'paid' } };
      case 'opted_in':
        return { updatesOptIn: true };
      default:
        return {};
    }
  }

  private async registrantPeople(filter: RegistrantFilter): Promise<{
    people: CsvPerson[];
    invalid: number;
    duplicates: number;
  }> {
    const rows = await this.prisma.waitlistRegistration.findMany({
      where: this.registrantWhere(filter),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { email: true, fullName: true },
    });
    const seen = new Set<string>();
    const people: CsvPerson[] = [];
    let invalid = 0;
    let duplicates = 0;
    for (const r of rows) {
      const email = r.email.trim().toLowerCase();
      if (!isValidEmail(email)) invalid += 1;
      else if (seen.has(email)) duplicates += 1;
      else {
        seen.add(email);
        people.push({ email, firstName: firstNameOf(r.fullName) });
      }
    }
    return { people, invalid, duplicates };
  }

  /**
   * Who is skipped. Who Made This: every EmailSuppression row. Voices: only the
   * rows with reason bounced or complained, plus the Voices unsubscribes.
   */
  private async suppressedAmong(
    people: CsvPerson[],
    brand: EmailBrand = 'wmt',
  ): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < people.length; i += 5000) {
      const emails = people.slice(i, i + 5000).map((p) => p.email);
      const rows = await this.prisma.emailSuppression.findMany({
        where: {
          email: { in: emails },
          ...(brand === 'voices'
            ? { reason: { in: ['bounced', 'complained'] as const } }
            : {}),
        },
        select: { email: true },
      });
      for (const r of rows) found.add(r.email);
      if (brand === 'voices') {
        const own = await this.prisma.emailBrandSuppression.findMany({
          where: { email: { in: emails }, brand: 'voices' },
          select: { email: true },
        });
        for (const r of own) found.add(r.email);
      }
    }
    return found;
  }

  private async memberPeople(
    which: 'accounts' | 'voices',
  ): Promise<MemberPeople> {
    if (which === 'voices') {
      const api = voicesApi(this.config);
      if (!api) return { available: false, reason: VOICES_NOT_LIVE };
      return readMemberList({
        base: api.base,
        path: '/internal/mail/audience',
        key: api.key,
        down: 'Voices did not answer, so its members cannot be listed. Try again in a minute.',
      });
    }
    const base = relayBaseUrl(this.config);
    const key = relayServiceKey(this.config);
    if (!base || !key) {
      return {
        available: false,
        reason:
          'WAWU ID is not set up on this server, so accounts cannot be listed.',
      };
    }
    const found = await readMemberList({
      base,
      path: '/internal/mail/audience',
      key,
      down: 'WAWU ID did not answer, so accounts cannot be listed. Try again in a minute.',
      missing: 'The list of accounts is not available from WAWU ID yet.',
    });
    if (!found.available) return found;
    // WAWU ID's list holds every WAWU ID account (Voices-only sign-ups too).
    // Keep only people with a Hub profile (a WMT account), who are not
    // deleted (an AccountDeletion row that is not cancelled: freezing,
    // scheduled, purging or purged) and not suspended.
    const ids = found.people.flatMap((p) => (p.id ? [p.id] : []));
    const profiles = new Set<string>();
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = ids.slice(i, i + 5000);
      const [prof, del, sus] = await Promise.all([
        this.prisma.userProfile.findMany({
          where: { wawuUserId: { in: chunk } },
          select: { wawuUserId: true },
        }),
        this.prisma.accountDeletion.findMany({
          where: { wawuUserId: { in: chunk }, status: { not: 'cancelled' } },
          select: { wawuUserId: true },
        }),
        this.prisma.userSuspension.findMany({
          where: { wawuUserId: { in: chunk }, liftedAt: null },
          select: { wawuUserId: true },
        }),
      ]);
      for (const r of prof) profiles.add(r.wawuUserId);
      for (const r of [...del, ...sus]) out.add(r.wawuUserId);
    }
    return {
      ...found,
      people: found.people.filter(
        (p) => p.id && profiles.has(p.id) && !out.has(p.id),
      ),
    };
  }

  /** The number shown before a members list (accounts or Voices) is built. */
  async memberCount(
    which: 'accounts' | 'voices',
    template: EmailBrand,
    limit?: number,
  ): Promise<EmailAudienceCountView> {
    const found = await this.memberPeople(which);
    if (!found.available) {
      return {
        matching: 0,
        willSend: 0,
        unsubscribed: 0,
        available: false,
        reason: found.reason,
      };
    }
    const plan = planAudience(
      found.people,
      await this.suppressedAmong(found.people, template),
      limit,
    );
    return {
      matching: found.people.length,
      willSend: plan.eligible.length,
      unsubscribed: plan.suppressed.length,
      available: true,
    };
  }

  async createFromMembers(
    which: 'accounts' | 'voices',
    templateId: string,
    limit: number | undefined,
    admin: AdminUserView,
  ): Promise<EmailCampaignView> {
    const template = await this.template(templateId);
    const found = await this.memberPeople(which);
    if (!found.available) throw new ConflictException(found.reason);
    return this.build({
      template,
      kind: which,
      note:
        which === 'voices'
          ? `Voices members${limit ? `, first ${limit}` : ''}`
          : `Everyone with a WMT account${limit ? `, first ${limit}` : ''}`,
      people: found.people,
      invalid: found.invalid,
      duplicates: found.duplicates,
      limit,
      admin,
    });
  }

  /** The number shown before anything is built or sent. */
  async registrantCount(
    filter: RegistrantFilter,
    limit?: number,
    brand: EmailBrand = 'wmt',
  ): Promise<EmailAudienceCountView> {
    const { people } = await this.registrantPeople(filter);
    const plan = planAudience(
      people,
      await this.suppressedAmong(people, brand),
      limit,
    );
    return {
      matching: people.length,
      willSend: plan.eligible.length,
      unsubscribed: plan.suppressed.length,
    };
  }

  // ── campaigns ──────────────────────────────────────────────────────────────

  async createFromRegistrants(
    templateId: string,
    filter: RegistrantFilter,
    limit: number | undefined,
    admin: AdminUserView,
  ): Promise<EmailCampaignView> {
    const template = await this.template(templateId);
    const { people, invalid, duplicates } = await this.registrantPeople(filter);
    const labels: Record<RegistrantFilter, string> = {
      all: 'all registrants',
      paid: 'registrants who paid',
      not_paid: 'registrants who have not paid',
      opted_in: 'registrants who opted in to updates',
    };
    return this.build({
      template,
      kind: 'registrants',
      note: `Join registrants: ${labels[filter]}${limit ? `, first ${limit}` : ''}`,
      people,
      invalid,
      duplicates,
      limit,
      admin,
    });
  }

  async createFromCsv(
    templateId: string,
    csv: string,
    fileName: string,
    limit: number | undefined,
    admin: AdminUserView,
  ): Promise<EmailCampaignView> {
    const template = await this.template(templateId);
    let parsed;
    try {
      parsed = parseAudienceCsv(csv);
    } catch (e) {
      if (e instanceof CsvFormatError) throw new BadRequestException(e.message);
      throw e;
    }
    if (parsed.people.length === 0) {
      throw new BadRequestException(
        'No valid email addresses were found in the file.',
      );
    }
    return this.build({
      template,
      kind: 'csv',
      note: `CSV upload (${fileName.slice(0, 80)})${limit ? `, first ${limit}` : ''}`,
      people: parsed.people,
      invalid: parsed.invalid,
      duplicates: parsed.duplicates,
      limit,
      admin,
    });
  }

  private async build(args: {
    template: EmailTemplateModel;
    kind: 'csv' | 'registrants' | 'accounts' | 'voices';
    note: string;
    people: CsvPerson[];
    invalid: number;
    duplicates: number;
    limit: number | undefined;
    admin: AdminUserView;
  }): Promise<EmailCampaignView> {
    const plan = planAudience(
      args.people,
      await this.suppressedAmong(args.people, brandOf(args.template.brand)),
      args.limit,
    );
    const total = plan.eligible.length + plan.suppressed.length;
    if (plan.eligible.length === 0) {
      throw new BadRequestException('Nobody in that audience can be emailed.');
    }
    if (total > MAX_CAMPAIGN_RECIPIENTS) {
      throw new BadRequestException(
        `That is more than ${MAX_CAMPAIGN_RECIPIENTS} people. Set a limit.`,
      );
    }
    const campaign = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.emailCampaign.create({
          data: {
            templateId: args.template.id,
            templateName: args.template.name,
            subject: args.template.subject,
            previewText: args.template.previewText,
            body: args.template.body,
            brand: brandOf(args.template.brand),
            buttonText: args.template.buttonText,
            buttonUrl: args.template.buttonUrl,
            audienceKind: args.kind,
            audienceNote: args.note,
            totalCount: total,
            skippedCount: plan.suppressed.length,
            invalidCount: args.invalid,
            duplicateCount: args.duplicates,
            createdBy: args.admin.id,
          },
        });
        const rows = [
          ...plan.eligible.map((p) => ({
            ...p,
            status: 'queued' as const,
            error: null,
          })),
          ...plan.suppressed.map((p) => ({
            ...p,
            status: 'skipped' as const,
            error: 'unsubscribed',
          })),
        ];
        for (let i = 0; i < rows.length; i += 1000) {
          await tx.emailRecipient.createMany({
            data: rows.slice(i, i + 1000).map((r) => ({
              campaignId: created.id,
              email: r.email,
              firstName: r.firstName,
              status: r.status,
              error: r.error,
            })),
          });
        }
        return created;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return this.view(campaign);
  }

  async start(id: string): Promise<EmailCampaignView> {
    const campaign = await this.campaign(id);
    const missing = this.sending.missingSetting();
    if (missing) throw new ConflictException(missing);
    const claim = await this.prisma.emailCampaign.updateMany({
      where: { id, status: 'ready' },
      data: { status: 'sending', startedAt: new Date() },
    });
    if (claim.count !== 1) {
      throw new ConflictException(
        campaign.status === 'ready'
          ? 'This campaign could not be started. Try again.'
          : 'This campaign has already been started.',
      );
    }
    this.sending.startRun(id);
    return this.detail(id);
  }

  async list(
    page: number,
    perPage: number,
  ): Promise<Paginated<EmailCampaignView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.emailCampaign.count(),
    ]);
    const items = await Promise.all(rows.map((r) => this.view(r)));
    return { items, currentPage: page, perPage, total };
  }

  async detail(id: string): Promise<EmailCampaignView> {
    return this.view(await this.campaign(id));
  }

  /** Superadmin: carry on a campaign a limit paused (daily or monthly). */
  async resume(id: string): Promise<EmailCampaignView> {
    await this.campaign(id);
    const missing = this.sending.missingSetting();
    if (missing) throw new ConflictException(missing);
    if (!(await this.sending.resume(id))) {
      throw new ConflictException('This campaign is not paused.');
    }
    return this.detail(id);
  }

  async recipients(
    id: string,
    query: EmailRecipientQueryDto,
  ): Promise<Paginated<EmailRecipientView>> {
    await this.campaign(id);
    const where: Prisma.EmailRecipientWhereInput = {
      campaignId: id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.delivery ? { delivery: query.delivery } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailRecipient.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
      }),
      this.prisma.emailRecipient.count({ where }),
    ]);
    return {
      items: rows.map(recipientView),
      currentPage: query.page,
      perPage: query.perPage,
      total,
    };
  }

  private async campaign(id: string): Promise<EmailCampaignModel> {
    const row = await this.prisma.emailCampaign.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('That campaign does not exist.');
    return row;
  }

  /** Live counts from the recipient rows, so the page is right mid-send. */
  private async view(c: EmailCampaignModel): Promise<EmailCampaignView> {
    const groups = await this.prisma.emailRecipient.groupBy({
      by: ['status'],
      where: { campaignId: c.id },
      _count: { _all: true },
    });
    const n = (s: string) =>
      groups.find((g) => g.status === s)?._count._all ?? 0;
    const unsubscribed = await this.prisma.emailRecipient.count({
      where: { campaignId: c.id, status: 'skipped', error: 'unsubscribed' },
    });
    const delivered = await this.prisma.emailRecipient.groupBy({
      by: ['delivery'],
      where: { campaignId: c.id, delivery: { not: null } },
      _count: { _all: true },
    });
    const d = (s: string) =>
      delivered.find((g) => g.delivery === s)?._count._all ?? 0;
    return {
      id: c.id,
      brand: brandOf(c.brand),
      buttonText: c.buttonText,
      buttonUrl: c.buttonUrl,
      deliveredCount: d('delivered'),
      delayedCount: d('delayed'),
      bouncedCount: d('bounced'),
      complainedCount: d('complained'),
      pausedUntil: c.pausedUntil,
      pauseReason: c.pauseReason,
      templateName: c.templateName,
      subject: c.subject,
      audienceKind: c.audienceKind,
      audienceNote: c.audienceNote,
      status: c.status,
      totalCount: groups.reduce((a, g) => a + g._count._all, 0),
      queuedCount: n('queued'),
      sentCount: n('sent'),
      failedCount: n('failed'),
      skippedCount: n('skipped'),
      unsubscribedCount: unsubscribed,
      invalidCount: c.invalidCount,
      duplicateCount: c.duplicateCount,
      createdAt: c.createdAt,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
    };
  }
}
