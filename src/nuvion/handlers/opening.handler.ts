import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  alignClaim,
  CANCELLED_BY_ADMIN,
  CLAIM_LOST,
  type ClaimAlignment,
  EXPIRED_STATE,
} from '../../money/opening/bvn-claim';
import { noteDocumentRefusals } from '../../money/opening/document-refusals';
import { tellWalletReady } from '../../money/opening/wallet-ready-notice';
import { WorldWalletService } from '../../money/world/world-wallet.service';
import {
  type DecisionNotice,
  isDecision,
  isNewDecision,
  noticeOf,
  type EntityStage,
  openingStateForStage,
  REVIEW_OPENING_STATES,
  reviewStageOf,
} from '../../money/opening/review-stage';
import { NotificationService } from '../../notification/notification.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { NuvionAccountsArea } from '../areas/accounts';
import {
  NUVION_OPENING_SEARCH,
  type NuvionEntityReading,
  type NuvionNairaAccount,
  NuvionOpeningArea,
} from '../areas/opening';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import { NuvionAccountRecorder } from './accounts';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What recording a delivery left: the stage, the claim, who is to be told. */
interface Recorded {
  stage: EntityStage;
  claim: ClaimAlignment;
  notice: DecisionNotice | null;
}

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });
const wait = (note: string): NuvionHandlerResult => ({ outcome: 'wait', note });

/**
 * Opening (task NUV-02): Nuvion's `entities.created` and `entities.updated`
 * (webhooks__event-types.md; `data` is the entity object). This file is
 * NUV-02's alone.
 *
 * For each delivery, the entity is read back first (`GET /entities/{id}`;
 * the docs advise acting on the resource, never on the delivery), then:
 * - **recorded**: NuvionEntity takes Nuvion's review word, each check's
 *   word (the BVN's, the NIN's, the ID document's, the proof of address's)
 *   and Nuvion's own words for a refusal, masked; `decidedAt` when a decision
 *   is new (`isNewDecision`: the word became one, or the same word after the
 *   person submitted since the last decision with a check that came to a
 *   verdict; Nuvion's own `updated` time is not read; N4). The person's
 *   opening follows the stage (src/money/opening/review-stage.ts), so the
 *   wallet gate and `GET /money/wallet` agree with Nuvion. An opening that
 *   expired and that Nuvion is checking or has approved is live again.
 * - **the claim on the BVN** follows what the entity still carries
 *   (src/money/opening/bvn-claim.ts, `holdsBvn`): held while it is with
 *   Nuvion, approved, refused only on documents, or has an account; let go
 *   by a refusal of the BVN or NIN themselves and by a failed or suspended
 *   entity with no account. An approval whose BVN another account holds
 *   meanwhile opens nothing: the person is stopped and told to contact
 *   support (once).
 * - **told**: a new decision (approved, rejected with what to fix, stopped)
 *   writes one notification (NotificationService, kind `identity_review`),
 *   after it is recorded and only by the delivery that recorded it, so a
 *   replay or a second delivery of the same decision tells nobody twice.
 * - **adopted**: an entity no NuvionEntity row names yet is the one a create
 *   whose answer was lost made, when exactly one opening of ours that is
 *   still in flight or unknown has the entity's phone and was sent before
 *   the entity was made (less the clock skew); it is recorded for that
 *   person. Anyone else's entity is left alone.
 * - **approved**: the person's one NGN `checking` account is opened
 *   (`POST /accounts`), once. Its claim (`accountRequestedAt`) is taken by a
 *   conditional update before anything is sent, so two deliveries at once
 *   or a replay send one request; and before any request, and after any
 *   answer that was lost or says the account exists, Nuvion's list of the
 *   entity's NGN checking accounts is read and an account there is recorded
 *   instead (`GET /accounts`). A lost request is never sent again until the
 *   money timeout plus the resend safety has passed and the list shows none.
 *
 * Only under `WALLET_PROVIDER=nuvion`: a server running Fintava leaves the
 * delivery pending (`wait`) for the server that runs Nuvion (rollback
 * safety, NUV-01). The adapter is found at run time (ModuleRef), so the
 * webhook module (NUV-01's) needs no new import. Notes are our own words:
 * never a number, a name or Nuvion's text.
 */
@Injectable()
export class NuvionOpeningHandler implements NuvionEventHandler {
  private readonly logger = new Logger(NuvionOpeningHandler.name);
  readonly task = 'NUV-02';
  readonly events: readonly NuvionWebhookEventName[] = [
    'entities.created',
    'entities.updated',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(delivery: NuvionDelivery): Promise<NuvionHandlerResult> {
    const nuvion = this.runningNuvion();
    if (nuvion === null) {
      return wait('this server does not run Nuvion; kept for one that does');
    }
    const data = isRecord(delivery.data) ? delivery.data : null;
    const entityId =
      delivery.resourceId ??
      (data && typeof data.id === 'string' ? data.id : null);
    if (entityId === null) return done('no entity named; nothing to do');
    if (data && typeof data.type === 'string' && data.type !== 'individual') {
      return done('not a person; nothing to do');
    }
    const area = new NuvionOpeningArea(nuvion.client);

    let read: NuvionEntityReading;
    try {
      read = await area.readEntity(entityId);
    } catch (e) {
      return wait(`the entity could not be read back (${kindOf(e)})`);
    }
    if (read.type !== null && read.type !== 'individual') {
      return done('not a person; nothing to do');
    }

    let owner = await this.prisma.nuvionEntity.findUnique({
      where: { entityId: read.entityId },
      select: { wawuUserId: true, accountId: true },
    });
    let recorded: Recorded;
    if (owner === null) {
      const adopted = await this.adopt(read);
      if (adopted === null) return done('not an opening of ours; left alone');
      owner = { wawuUserId: adopted.wawuUserId, accountId: null };
      recorded = adopted;
    } else {
      recorded = await this.recordReview(owner.wawuUserId, read);
    }
    await this.tell(owner.wawuUserId, recorded.notice);

    if (read.status !== 'approved') return done(`recorded (${read.status})`);
    if (recorded.claim === 'stopped' || recorded.claim === 'stopped_now') {
      // Approved for a BVN another account holds: nothing is opened.
      return {
        outcome: 'failed',
        note: 'approved, but the BVN is held by another account; no account opened, left for review',
      };
    }
    if (owner.accountId !== null) return done('approved; account already open');
    // WALLET-41 (R-87): a person outside Nigeria has no naira account; their
    // first account is in the currency they chose.
    const world = await this.prisma.fintavaWalletOpening.findUnique({
      where: { wawuUserId: owner.wawuUserId },
      select: { worldCountry: true },
    });
    if (world?.worldCountry) return this.openWorldAccount(owner.wawuUserId);
    return this.ensureAccount(area, read.entityId, nuvion);
  }

  /** The first account of an approved person outside Nigeria (see WorldWalletService). */
  private async openWorldAccount(
    wawuUserId: string,
  ): Promise<NuvionHandlerResult> {
    let service: WorldWalletService;
    try {
      service = this.moduleRef.get(WorldWalletService, { strict: false });
    } catch {
      return wait(
        'this server cannot open a world account; kept for one that can',
      );
    }
    try {
      const how = await service.ensureFirstAccount(wawuUserId);
      return how === 'waiting'
        ? wait('approved; the first account is being opened')
        : done(`approved; world first account ${how}`);
    } catch (e) {
      const why =
        e instanceof WalletProviderError
          ? e.kind
          : ((e as { code?: string }).code ?? (e as Error).name ?? 'Error');
      return wait(`the first account could not be opened (${why})`);
    }
  }

  // -------------------------------------------------------------------------

  /** The running adapter when it is Nuvion's; null otherwise. */
  private runningNuvion(): NuvionWalletProvider | null {
    let provider: WalletProvider;
    try {
      provider = this.moduleRef.get<WalletProvider>(WALLET_PROVIDER, {
        strict: false,
      });
    } catch {
      return null;
    }
    return provider instanceof NuvionWalletProvider ? provider : null;
  }

  /**
   * The review's words on the person's row, their opening's stage, and the
   * claim on their BVN. A decision is recorded by a compare-and-set on the
   * word and the decision time it was read with, so the one delivery that
   * wins is the one that tells the person.
   */
  private async recordReview(
    wawuUserId: string,
    read: NuvionEntityReading,
  ): Promise<Recorded> {
    // The database's clock, as the correction's time is (`correctedAt`), so
    // "after the correction" never depends on a server's own clock.
    const now = await this.dbNow();
    const words = {
      personId: read.personId ?? undefined,
      status: read.status,
      bvnStatus: read.bvnStatus,
      ninStatus: read.ninStatus,
      documentStatus: read.documentStatus,
      addressProofStatus: read.addressProofStatus,
      identificationStatus: read.identificationStatus,
      rejectionReasons: read.reasons,
      reviewReadAt: now,
      ...(read.updated !== null
        ? { entityUpdatedAt: new Date(read.updated) }
        : {}),
    };
    const done = await this.prisma.$transaction(async (tx) => {
      const before = await tx.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId },
        select: {
          status: true,
          decidedAt: true,
          submittedAt: true,
          bvnStatus: true,
          ninStatus: true,
          documentStatus: true,
          addressProofStatus: true,
          identificationStatus: true,
        },
      });
      // Whether the person was already stopped (told once) before this read.
      const wasStopped = ['failed', 'suspended'].includes(
        before.status.trim().toLowerCase(),
      );
      const fresh = isNewDecision(before, read);
      const won = await tx.nuvionEntity.updateMany({
        where: {
          wawuUserId,
          status: before.status,
          decidedAt: before.decidedAt,
        },
        data: { ...words, ...(fresh ? { decidedAt: now } : {}) },
      });
      const after = await tx.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId },
        select: {
          status: true,
          decidedAt: true,
          correctedAt: true,
          bvnStatus: true,
          ninStatus: true,
          documentStatus: true,
          addressProofStatus: true,
          rejectionReasons: true,
        },
      });
      const stage = reviewStageOf(after);
      // A document Nuvion's review refused goes on the document's own row
      // in the same step that records the word, so a correction that is
      // answered with the check back at `pending` cannot lose it (NUV-03
      // round 2, D1).
      await noteDocumentRefusals(tx, wawuUserId, after, now);
      // An opening that expired (idle too long, or released by support) and
      // that Nuvion is nevertheless checking or has approved is live again:
      // the entity carries the BVN in a live state, so the hold comes back
      // (`alignClaim` below; if another account took the number meanwhile,
      // the opening is stopped and nothing is opened). A refusal or a wait
      // for documents leaves it expired: the person starts again.
      if (stage === 'checking' || stage === 'approved') {
        const revived = await tx.fintavaWalletOpening.updateMany({
          where: { wawuUserId, provider: 'nuvion', state: EXPIRED_STATE },
          data: { state: openingStateForStage(stage), failure: null },
        });
        if (revived.count === 1) {
          await tx.nuvionEntity.updateMany({
            where: { wawuUserId },
            data: { holdExpiredAt: null },
          });
        }
      }
      await tx.fintavaWalletOpening.updateMany({
        where: {
          wawuUserId,
          provider: 'nuvion',
          state: { in: [...REVIEW_OPENING_STATES, 'unknown'] },
          OR: [
            { failure: null },
            { failure: { notIn: [CLAIM_LOST, CANCELLED_BY_ADMIN] } },
          ],
        },
        data: { state: openingStateForStage(stage), failure: null },
      });
      return {
        stage,
        wasStopped,
        notice: won.count === 1 && fresh ? noticeOf(after) : null,
      };
    });
    return this.settleClaim(wawuUserId, done);
  }

  /**
   * After the opening follows the stage, the claim on the BVN follows it too
   * (`alignClaim`: held while the provider's entity still carries the BVN,
   * let go when it does not). A BVN that is another account's now stops the
   * opening, and the person is told that instead of anything else, unless
   * they were already stopped and told (one "stopped" notice, N10).
   */
  private async settleClaim(
    wawuUserId: string,
    recorded: {
      stage: EntityStage;
      notice: DecisionNotice | null;
      wasStopped?: boolean;
    },
  ): Promise<Recorded> {
    const claim = await alignClaim(this.prisma, wawuUserId);
    if (claim === 'stopped_now') {
      this.logger.error(
        'nuvion opening: the BVN reviewed is held by another account now; the opening is stopped for review',
      );
      return {
        stage: recorded.stage,
        claim,
        notice: recorded.wasStopped ? null : { outcome: 'stopped' },
      };
    }
    return {
      stage: recorded.stage,
      claim,
      notice: claim === 'stopped' ? null : recorded.notice,
    };
  }

  private async dbNow(): Promise<Date> {
    const [r] = await this.prisma.$queryRaw<Array<{ now: Date | string }>>`
      SELECT now() AS "now"
    `;
    return new Date(r.now);
  }

  /** One notification for a new decision; none when there is nothing new. */
  private async tell(
    wawuUserId: string,
    notice: DecisionNotice | null,
  ): Promise<void> {
    if (notice === null) return;
    let notifications: NotificationService;
    try {
      notifications = this.moduleRef.get(NotificationService, {
        strict: false,
      });
    } catch {
      this.logger.warn(
        'nuvion opening: no notification service here; the person was not told',
      );
      return;
    }
    await notifications.emit({
      kind: 'identity_review',
      userWawuId: wawuUserId,
      outcome: notice.outcome,
      ...(notice.outcome === 'rejected' ? { fixes: notice.fixes } : {}),
    });
  }

  /**
   * The entity a lost create made, for the one opening it can be: a Nuvion
   * opening in flight or unknown, with the entity's phone, sent before the
   * entity was made (less the clock skew). What was recorded for the person,
   * or null.
   */
  private async adopt(
    read: NuvionEntityReading,
  ): Promise<(Recorded & { wawuUserId: string }) | null> {
    if (read.phone === null) return null;
    const candidates = await this.prisma.fintavaWalletOpening.findMany({
      where: {
        phone: read.phone,
        provider: 'nuvion',
        state: { in: ['opening', 'unknown'] },
      },
      select: { wawuUserId: true, attempts: true, attemptStartedAt: true },
    });
    const made = read.created;
    const fits = candidates.filter(
      (c) =>
        made === null ||
        c.attemptStartedAt.getTime() - NUVION_OPENING_SEARCH.clockSkewMs <=
          made,
    );
    if (fits.length !== 1) return null;
    const [c] = fits;
    const now = await this.dbNow();
    let adopted: { stage: EntityStage; notice: DecisionNotice | null };
    try {
      adopted = await this.prisma.$transaction(async (tx) => {
        const held = await tx.nuvionEntity.findUnique({
          where: { wawuUserId: c.wawuUserId },
          select: { entityId: true },
        });
        if (held?.entityId && held.entityId !== read.entityId) {
          throw new Error('the person has another entity');
        }
        const row = await tx.nuvionEntity.upsert({
          where: { wawuUserId: c.wawuUserId },
          create: {
            wawuUserId: c.wawuUserId,
            entityId: read.entityId,
            personId: read.personId,
            status: read.status,
            decidedAt: isDecision(read.status) ? now : null,
            bvnStatus: read.bvnStatus,
            ninStatus: read.ninStatus,
            documentStatus: read.documentStatus,
            addressProofStatus: read.addressProofStatus,
            identificationStatus: read.identificationStatus,
            rejectionReasons: read.reasons,
            reviewReadAt: now,
            entityUpdatedAt:
              read.updated !== null ? new Date(read.updated) : null,
          },
          update: {
            entityId: read.entityId,
            personId: read.personId,
            status: read.status,
            reviewReadAt: now,
          },
        });
        const stage = reviewStageOf(row);
        await tx.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId: c.wawuUserId,
            attempts: c.attempts,
            state: { in: ['opening', 'unknown'] },
          },
          data: {
            state: openingStateForStage(stage),
            failure: null,
          },
        });
        return { stage, notice: noticeOf(row) };
      });
    } catch {
      this.logger.error(
        'nuvion opening: an entity matched an opening that already holds another; left for review',
      );
      return null;
    }
    this.logger.log(
      'nuvion opening: an entity a lost answer made was recorded',
    );
    return {
      wawuUserId: c.wawuUserId,
      ...(await this.settleClaim(c.wawuUserId, adopted)),
    };
  }

  /** The person's one naira account, opened once (see the class comment). */
  private async ensureAccount(
    area: NuvionOpeningArea,
    entityId: string,
    nuvion: NuvionWalletProvider,
  ): Promise<NuvionHandlerResult> {
    const t = nuvion.timings;
    const now = new Date();
    const lapsed = new Date(
      now.getTime() - (t.moneyTimeoutMs + t.resendSafetyMs),
    );
    const before = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { accountRequestedAt: true },
    });
    const claimed = await this.prisma.nuvionEntity.updateMany({
      where: {
        entityId,
        accountId: null,
        status: 'approved',
        OR: [
          { accountRequestedAt: null },
          { accountRequestedAt: { lt: lapsed } },
        ],
      },
      data: { accountRequestedAt: now },
    });
    if (claimed.count !== 1) {
      const row = await this.prisma.nuvionEntity.findUnique({
        where: { entityId },
        select: { accountId: true },
      });
      return row?.accountId
        ? done('approved; account already open')
        : wait('the account is being opened by another worker');
    }
    // An earlier request may have made it: look before asking again.
    const release = () =>
      this.prisma.nuvionEntity.updateMany({
        where: { entityId, accountId: null, accountRequestedAt: now },
        data: { accountRequestedAt: before?.accountRequestedAt ?? null },
      });
    let found: NuvionNairaAccount | null;
    try {
      found = await area.findNairaAccount(entityId);
    } catch (e) {
      await release();
      return wait(`the account list could not be read (${kindOf(e)})`);
    }
    if (found) return this.recordAccount(entityId, found, 'found', nuvion);

    let made: NuvionNairaAccount;
    try {
      made = await area.openNairaAccount(entityId);
    } catch (e) {
      if (e instanceof WalletProviderError && e.recordMayExist) {
        // Lost, or "already exists": look again; else keep the claim so
        // nothing is sent again before the resend window has passed.
        try {
          const again = await area.findNairaAccount(entityId);
          if (again)
            return this.recordAccount(entityId, again, 'found', nuvion);
        } catch {
          // The list tells nothing now; the claim stands.
        }
        return wait(
          `the account request's answer was lost (${kindOf(e)}); looked for before any new one`,
        );
      }
      // Refused, nothing made: the claim goes, and it is tried again later.
      await this.prisma.nuvionEntity.updateMany({
        where: { entityId, accountId: null, accountRequestedAt: now },
        data: { accountRequestedAt: null },
      });
      return wait(`the account request was refused (${kindOf(e)})`);
    }
    return this.recordAccount(entityId, made, 'opened', nuvion);
  }

  private async recordAccount(
    entityId: string,
    account: NuvionNairaAccount,
    how: 'found' | 'opened',
    nuvion: NuvionWalletProvider,
  ): Promise<NuvionHandlerResult> {
    try {
      const recorded = await this.prisma.nuvionEntity.updateMany({
        where: { entityId, accountId: null },
        data: {
          accountId: account.accountId,
          nuvionBan: account.nuvionBan,
          currency: account.currency,
        },
      });
      if (recorded.count !== 1) return done('approved; account already open');
    } catch {
      this.logger.error(
        'nuvion opening: the naira account is recorded for someone else; left for review',
      );
      return {
        outcome: 'failed',
        note: 'the account is recorded for someone else',
      };
    }
    this.logger.log(`nuvion opening: naira account ${how} and recorded`);
    await this.requestDetails(nuvion, entityId, account.accountId);
    return done(`approved; naira account ${how}`);
  }

  /**
   * WALK4-FIX M-1. The account number is asked for here, right after the account is recorded, and not only when Nuvion's one
   * `accounts.created` delivery arrives: a lost delivery left "on its way" for good. The request is the same one that delivery
   * makes (NuvionAccountRecorder.ensureDetails): the details are listed first, the ask is claimed with a conditional update, so
   * this path, the delivery and the sweep on any server ask once, and it never makes an account. A step that cannot finish now
   * does not undo the account or fail the opening: the sweep asks for the details of an account that has none after 5 minutes.
   * Without the notification service the number would be recorded with no notice, so then nothing is asked here.
   */
  private async requestDetails(
    nuvion: NuvionWalletProvider,
    entityId: string,
    accountId: string,
  ): Promise<void> {
    let notifications: NotificationService;
    try {
      notifications = this.moduleRef.get(NotificationService, {
        strict: false,
      });
    } catch {
      this.logger.warn(
        'nuvion opening: no notification service here; the account number is asked for by the sweep',
      );
      return;
    }
    try {
      const recorder = new NuvionAccountRecorder(
        this.prisma,
        new NuvionAccountsArea(nuvion.client),
        nuvion.client.settings,
        (tx, wawuUserId) => tellWalletReady(notifications, tx, wawuUserId),
      );
      const asked = await recorder.ensureDetails(null, entityId, accountId);
      this.logger.log(`nuvion opening: account details ${asked.outcome}`);
    } catch (e) {
      // The name only: a message can quote what Nuvion sent.
      this.logger.warn(
        `nuvion opening: the account details could not be asked for now (${(e as Error).name ?? 'Error'}); the sweep asks later`,
      );
    }
  }
}

function kindOf(e: unknown): string {
  return e instanceof WalletProviderError
    ? e.kind
    : ((e as Error).name ?? 'Error');
}
