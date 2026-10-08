import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  isDecision,
  openingStateForStage,
  REVIEW_OPENING_STATES,
  reviewStageOf,
} from '../../money/opening/review-stage';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import {
  NUVION_OPENING_SEARCH,
  type NuvionEntityReading,
  type NuvionNairaAccount,
  NuvionOpeningArea,
} from '../areas/opening';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
 *   and Nuvion's own words for a refusal, masked; `decidedAt` when the word
 *   becomes a decision. The person's opening follows the stage
 *   (src/money/opening/review-stage.ts), so the wallet gate and
 *   `GET /money/wallet` agree with Nuvion.
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
    if (owner === null) {
      const adopted = await this.adopt(read);
      if (adopted === null) return done('not an opening of ours; left alone');
      owner = { wawuUserId: adopted, accountId: null };
    } else {
      await this.recordReview(owner.wawuUserId, read);
    }

    if (read.status !== 'approved') return done(`recorded (${read.status})`);
    if (owner.accountId !== null) return done('approved; account already open');
    return this.ensureAccount(area, read.entityId, nuvion);
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

  /** The review's words on the person's row, and their opening's stage. */
  private async recordReview(
    wawuUserId: string,
    read: NuvionEntityReading,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.nuvionEntity.findUniqueOrThrow({
        where: { wawuUserId },
        select: { status: true, decidedAt: true, correctedAt: true },
      });
      const now = new Date();
      const decidedAt =
        isDecision(read.status) &&
        (before.status !== read.status || before.decidedAt === null)
          ? now
          : before.decidedAt;
      const after = await tx.nuvionEntity.update({
        where: { wawuUserId },
        data: {
          personId: read.personId ?? undefined,
          status: read.status,
          decidedAt,
          bvnStatus: read.bvnStatus,
          ninStatus: read.ninStatus,
          documentStatus: read.documentStatus,
          addressProofStatus: read.addressProofStatus,
          identificationStatus: read.identificationStatus,
          rejectionReasons: read.reasons,
          reviewReadAt: now,
        },
      });
      await tx.fintavaWalletOpening.updateMany({
        where: {
          wawuUserId,
          provider: 'nuvion',
          state: { in: [...REVIEW_OPENING_STATES, 'unknown'] },
        },
        data: {
          state: openingStateForStage(reviewStageOf(after)),
          failure: null,
        },
      });
    });
  }

  /**
   * The entity a lost create made, for the one opening it can be: a Nuvion
   * opening in flight or unknown, with the entity's phone, sent before the
   * entity was made (less the clock skew). The person, or null.
   */
  private async adopt(read: NuvionEntityReading): Promise<string | null> {
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
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
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
          },
          update: {
            entityId: read.entityId,
            personId: read.personId,
            status: read.status,
            reviewReadAt: now,
          },
        });
        await tx.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId: c.wawuUserId,
            attempts: c.attempts,
            state: { in: ['opening', 'unknown'] },
          },
          data: {
            state: openingStateForStage(reviewStageOf(row)),
            failure: null,
          },
        });
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
    return c.wawuUserId;
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
    if (found) return this.recordAccount(entityId, found, 'found');

    let made: NuvionNairaAccount;
    try {
      made = await area.openNairaAccount(entityId);
    } catch (e) {
      if (e instanceof WalletProviderError && e.recordMayExist) {
        // Lost, or "already exists": look again; else keep the claim so
        // nothing is sent again before the resend window has passed.
        try {
          const again = await area.findNairaAccount(entityId);
          if (again) return this.recordAccount(entityId, again, 'found');
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
    return this.recordAccount(entityId, made, 'opened');
  }

  private async recordAccount(
    entityId: string,
    account: NuvionNairaAccount,
    how: 'found' | 'opened',
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
    return done(`approved; naira account ${how}`);
  }
}

function kindOf(e: unknown): string {
  return e instanceof WalletProviderError
    ? e.kind
    : ((e as Error).name ?? 'Error');
}
