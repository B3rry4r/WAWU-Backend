import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { CreditSpend } from '../common/types';
import { CreateCreditSpendDto } from './dto/create-credit-spend.dto';

/**
 * Either the shared client or an interactive-transaction client. The
 * CommunityMessage flow debits the balance, writes the message and writes
 * this ledger row inside ONE transaction, so `record()` has to be able to
 * run on that transaction's client rather than opening its own connection
 * (which would commit independently of the debit it is meant to document).
 */
export type CreditSpendPrismaClient = PrismaService | Prisma.TransactionClient;

/** Schema default for `CreditSpend.creditsSpent` / `CommunityMessage.costInCredits`. */
export const DEFAULT_CREDITS_SPENT = 1;

/**
 * The community-credits split, docs/01_SPEC.md §1 row 4: "Creator 90% /
 * WAWU 10%".
 *
 * IT IS 90/10 FOR EVERY CREATOR, ON EVERY TIER — this is NOT the Pro
 * override. Two independent lines of the locked spec say so:
 *   - §1 row 8 lists the Pro upgrade as applying to "streams 1, 2, 3, 5, 6".
 *     Credits are stream 4, and are conspicuously absent from that list.
 *   - §3: "Creator share (90%) rewards creators for building and moderating
 *     active communities — this is deliberately a better split than every
 *     other stream, not an error."
 * So a Basic-tier host and a Pro-tier host earn the same 90 on credits, and
 * this service must NOT consult CreatorState.tier. (creator-earnings.service
 * .ts resolves a per-creator commission rate for the other streams; credits
 * deliberately bypass it.)
 *
 * Expressed as integer numerator/denominator, not 0.9, so the arithmetic
 * below never leaves integer kobo.
 */
export const CREDITS_HOST_SHARE_NUMERATOR = 9;
export const CREDITS_HOST_SHARE_DENOMINATOR = 10;

/** Options for {@link CreditSpendService.record}. */
export interface RecordCreditSpendOptions {
  /**
   * Cap on how many open lots one spend may draw from. A spend is 1 credit
   * in this product (`1 credit = 1 message`), so it realistically touches
   * one lot; the cap exists only so a pathological data state cannot turn a
   * message send into an unbounded scan.
   */
  maxLots?: number;
}

const DEFAULT_MAX_LOTS = 8;

/**
 * CreditSpend is an append-only ledger: one row per paid message sent in a
 * community (docs/02_TECHNICAL_CONTEXT.md §2.4). registry.json's contract
 * for this resource declares an empty `endpoints` array — there is no
 * `/credit-spends` route. The row is written internally by the
 * CommunityMessage module's `POST /communities/:id/messages` handler (a
 * separate wave-0 resource, wired centrally after this wave) as the
 * audit/revenue-share trail for the community host's 90% share; this
 * service is that module's only entry point into this table.
 *
 * It is ALSO the entry point into the community host's earnings: every
 * ledger row written here is paired, in the same transaction, with a
 * CreditSpendEarning row carrying the naira the host earned at the spec's
 * 90/10 credits split. Read {@link CreditSpendService.recordEarning}'s doc
 * comment ("THE COST-BASIS MODEL") before touching any of it — the choice
 * of model is load-bearing and was made deliberately.
 *
 * Because there is no controller, there is no global ValidationPipe sitting
 * in front of `record()` — so this service validates its own input
 * explicitly (mirrors the same class-validator DTO pattern, just invoked
 * by hand) rather than trusting a caller-constructed object.
 */
@Injectable()
export class CreditSpendService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one credit-spend ledger row. `creditsSpent` is the real cost of
   * the message being recorded (`CommunityMessage.costInCredits`), falling
   * back to the schema default of 1 — it used to be hardcoded to 1, which
   * under-reported any message priced above the default and put the ledger
   * out of step with the balance actually debited. Does NOT touch
   * CreditsState's balance itself; debiting the spender is the caller's
   * (CommunityMessage's) responsibility per the documented flow — this
   * method only records that the spend happened.
   *
   * `client` lets the caller run this inside its own transaction so the
   * debit, the message and this row commit or roll back together.
   *
   * ALSO writes the CreditSpendEarning row that pays the community host
   * their 90% (see {@link recordEarning}). The caller passes no "was this
   * funded?" flag and does not need to: funding is DERIVED here by trying to
   * draw the credits out of the sender's open purchase lots. If lots have
   * credits left, the sender had a real balance and it was really debited;
   * if they do not, the send was trial-covered or drawn from unbacked
   * credits and is worth ₦0. Deriving it keeps the whole money model inside
   * this one file instead of splitting it across the caller.
   *
   * Throws BadRequestException on a malformed payload, NotFoundException
   * if `communityId` does not reference a real community (the ledger row
   * must never dangle a foreign key the Community relation can't satisfy).
   */
  async record(
    input: CreateCreditSpendDto,
    client: CreditSpendPrismaClient = this.prisma,
    options: RecordCreditSpendOptions = {},
  ): Promise<CreditSpend> {
    const dto = plainToInstance(CreateCreditSpendDto, input);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const firstConstraint = errors[0].constraints
        ? Object.values(errors[0].constraints)[0]
        : undefined;
      throw new BadRequestException(
        firstConstraint ?? 'Invalid credit spend payload.',
      );
    }

    const community = await client.community.findUnique({
      where: { id: dto.communityId },
      select: { id: true },
    });
    if (!community) {
      throw new NotFoundException(`Community ${dto.communityId} not found.`);
    }

    const creditsSpent = dto.creditsSpent ?? DEFAULT_CREDITS_SPENT;

    const spend = await client.creditSpend.create({
      data: {
        userWawuId: dto.userWawuId,
        communityId: dto.communityId,
        creatorWawuId: dto.creatorWawuId,
        creditsSpent,
      },
    });

    // The money half of the same event. Runs on the SAME client, so on the
    // CommunityMessage path it commits or rolls back with the debit, the
    // message and the ledger row — a host share can never exist for a
    // message that was never stored, and a stored message can never exist
    // without the host's share being computed for it.
    await this.recordEarning(spend, options, client);

    return spend;
  }

  /**
   * THE COST-BASIS MODEL — read this before changing anything below.
   *
   * WHAT THE SPEC SELLS. docs/01_SPEC.md §1 row 4: WAWU Credits, "Creator
   * 90% / WAWU 10%". §3: that share "rewards creators for building and
   * moderating active communities — this is deliberately a better split than
   * every other stream, not an error." Six app surfaces say "you keep 90% of
   * every credit spent in it". Until this method existed, nothing multiplied
   * anything by 0.9 and a host earned exactly nothing.
   *
   * WHY IT IS HARD. A credit is bought in a PACK and spent one at a time,
   * possibly months later, possibly out of several packs. The packs are not
   * the same price per credit (docs/01_SPEC.md §1 row 4): ₦500/50 = ₦10.00,
   * ₦1,000/120 = ₦8.33…, ₦2,000/300 = ₦6.66…. "What naira is this credit
   * worth" therefore has no platform-wide answer.
   *
   * OPTIONS CONSIDERED, AND WHY THIS ONE.
   *
   *   1. A single platform-wide rate (say ₦10, or a blended ₦8.33).
   *      REJECTED. It decouples what WAWU owes from what WAWU collected. A
   *      member who only ever buys the ₦2,000/300 pack pays ₦6.67 a credit;
   *      paying the host 90% of ₦10 for it is a ₦9 payout on ₦6.67 of
   *      revenue — a 135% payout, on a stream the spec defines as 90/10.
   *      A model that can contradict the split it implements is not a model.
   *
   *   2. Weighted-average cost per member, kept on their credits row.
   *      REJECTED. It drifts as purchases and spends interleave, it needs a
   *      money column on CreditsState (which IS a live wire type, spread
   *      into GET /credits — a naira figure would appear next to a member's
   *      credit COUNT, which CLAUDE.md forbids outright), and no individual
   *      payout can be traced back to a charge afterwards.
   *
   *   3. PER-PACK COST BASIS, CONSUMED FIFO. CHOSEN.
   *      Every completed purchase opens a CreditLot holding the exact kobo
   *      banked and the credits it bought. A spend draws from the oldest
   *      open lot first and carries THAT lot's real cost basis. The host
   *      gets 90% of money that actually exists, per credit, always — so the
   *      spec's split is literally true rather than approximately true, and
   *      every naira in the earnings ledger traces to one Flutterwave
   *      charge.
   *
   *      FIFO rather than LIFO or pro-rata because credits do not expire and
   *      are non-refundable (docs/01_SPEC.md §3 rules 1–2), so the only
   *      thing consumption order changes is which lot's basis a given credit
   *      carries — and "my oldest credits go first" is how a prepaid-unit
   *      buyer reasons about airtime, which is the exact analogy §3 uses.
   *      FIFO also makes the state monotone and replayable.
   *
   * EXACTNESS. Kobo per credit is distributed by largest remainder:
   * `floor(grossKobo * consumedAfter / granted) - allocatedKobo`. Over a
   * fully consumed lot the allocations sum to grossKobo exactly — no kobo
   * invented, none lost — which a fixed `round(gross/granted)` per credit
   * cannot promise on a 120-pack (₦1,000 / 120 = 833.33 kobo).
   *
   * THE HOST'S 90% IS FLOORED. The residual kobo (at most 1 per spend) stays
   * with WAWU. Rounding the other way would let total payouts exceed total
   * receipts, which is the one thing this model exists to make impossible.
   *
   * TRIAL-COVERED MESSAGES EARN THE HOST ₦0, AND THAT IS DELIBERATE. During
   * the 7-day trial (docs/01_SPEC.md §3) a member sends without holding
   * credits: nothing is debited and WAWU banks nothing. 90% of nothing is
   * nothing, and inventing a notional value would have WAWU paying real
   * naira out of revenue it never received — the same defect as option 1.
   * The message still writes its CreditSpend row, so the host's credit COUNT
   * and their community's activity are unaffected; only the naira is zero.
   * The same reasoning covers any credit sitting in a balance with no
   * completed purchase behind it (seeded, granted, or legacy): unfunded
   * credits are worth ₦0 because they cost ₦0. `creditsFunded` on the
   * earning row records exactly how many of the spend's credits were real,
   * so this is auditable rather than merely absorbed.
   *
   * REFUNDS AND FAILED CHARGES CANNOT LEAK. A lot is opened only by
   * CreditPurchaseService.verifyPurchase on a `completed` charge, and only a
   * lot can fund a spend, so a host share can never have been counted
   * against money that never cleared. Spec §3 rule 1 makes purchased credits
   * non-refundable, so there is no reversal path to unwind; if a chargeback
   * path is ever added it must zero the lot's `creditsRemaining` (stopping
   * FUTURE attribution) and must NOT claw back earnings already recorded
   * here — those credits were spent, the host delivered the community, and
   * the loss is WAWU's, not the host's.
   */
  private async recordEarning(
    spend: {
      id: string;
      userWawuId: string;
      communityId: string;
      creatorWawuId: string;
      creditsSpent: number;
    },
    options: RecordCreditSpendOptions,
    client: CreditSpendPrismaClient,
  ): Promise<void> {
    const maxLots = options.maxLots ?? DEFAULT_MAX_LOTS;

    let creditsToFund = spend.creditsSpent;
    let creditsFunded = 0;
    let grossKobo = 0;
    const lotIds: string[] = [];

    for (
      let attempt = 0;
      creditsToFund > 0 && attempt < maxLots;
      attempt += 1
    ) {
      const lot = await client.creditLot.findFirst({
        where: { userWawuId: spend.userWawuId, creditsRemaining: { gt: 0 } },
        orderBy: [{ purchasedAt: 'asc' }, { id: 'asc' }],
      });
      if (!lot) break;

      const take = Math.min(creditsToFund, lot.creditsRemaining);
      const consumedAfter = lot.creditsGranted - lot.creditsRemaining + take;
      // Largest-remainder allocation: what SHOULD be allocated once
      // `consumedAfter` credits are gone, minus what already is.
      const allocatedAfter = Math.floor(
        (lot.grossKobo * consumedAfter) / lot.creditsGranted,
      );
      const takeKobo = allocatedAfter - lot.allocatedKobo;

      // Conditional draw-down: the guard lives in the WHERE clause, so two
      // concurrent sends racing on the last credit of a lot cannot both win
      // (same pattern as the balance debit in CommunityMessageService).
      const { count } = await client.creditLot.updateMany({
        where: {
          id: lot.id,
          creditsRemaining: lot.creditsRemaining,
          allocatedKobo: lot.allocatedKobo,
        },
        data: {
          creditsRemaining: { decrement: take },
          allocatedKobo: { increment: takeKobo },
        },
      });
      if (count === 0) continue; // lost the race — re-read and try again

      creditsToFund -= take;
      creditsFunded += take;
      grossKobo += takeKobo;
      lotIds.push(lot.id);
    }

    const hostShareKobo = Math.floor(
      (grossKobo * CREDITS_HOST_SHARE_NUMERATOR) /
        CREDITS_HOST_SHARE_DENOMINATOR,
    );

    await client.creditSpendEarning.create({
      data: {
        creditSpendId: spend.id,
        creatorWawuId: spend.creatorWawuId,
        communityId: spend.communityId,
        creditsSpent: spend.creditsSpent,
        creditsFunded,
        grossKobo,
        hostShareKobo,
        platformShareKobo: grossKobo - hostShareKobo,
        lotIds,
      },
    });
  }

  /**
   * Internal read helper. Always bounded — an unbounded findMany over an
   * append-only ledger is an OOM waiting to happen on a busy creator.
   */
  async listForCreator(
    creatorWawuId: string,
    take = 50,
  ): Promise<CreditSpend[]> {
    return this.prisma.creditSpend.findMany({
      where: { creatorWawuId },
      orderBy: { spentAt: 'desc' },
      take,
    });
  }
}
