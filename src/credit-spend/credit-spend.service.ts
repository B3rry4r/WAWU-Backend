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
 * CreditSpend is an append-only ledger: one row per paid message sent in a
 * community (docs/02_TECHNICAL_CONTEXT.md §2.4). registry.json's contract
 * for this resource declares an empty `endpoints` array — there is no
 * `/credit-spends` route. The row is written internally by the
 * CommunityMessage module's `POST /communities/:id/messages` handler (a
 * separate wave-0 resource, wired centrally after this wave) as the
 * audit/revenue-share trail for the community host's 90% share; this
 * service is that module's only entry point into this table.
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
   * Throws BadRequestException on a malformed payload, NotFoundException
   * if `communityId` does not reference a real community (the ledger row
   * must never dangle a foreign key the Community relation can't satisfy).
   */
  async record(
    input: CreateCreditSpendDto,
    client: CreditSpendPrismaClient = this.prisma,
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

    return client.creditSpend.create({
      data: {
        userWawuId: dto.userWawuId,
        communityId: dto.communityId,
        creatorWawuId: dto.creatorWawuId,
        creditsSpent: dto.creditsSpent ?? DEFAULT_CREDITS_SPENT,
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
