import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreditSpend } from '../common/types';
import { CreateCreditSpendDto } from './dto/create-credit-spend.dto';

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
   * Records one credit-spend ledger row. `creditsSpent` is always 1 — never
   * accepted from the caller (registry.json note on the field; also
   * mirrors the schema's `@default(1)`). Does NOT touch CreditsState's
   * balance itself; decrementing the spender's balance is the caller's
   * (CommunityMessage's) responsibility per the documented flow — this
   * method only records that the spend happened.
   *
   * Throws BadRequestException on a malformed payload, NotFoundException
   * if `communityId` does not reference a real community (the ledger row
   * must never dangle a foreign key the Community relation can't satisfy).
   */
  async record(input: CreateCreditSpendDto): Promise<CreditSpend> {
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

    const community = await this.prisma.community.findUnique({
      where: { id: dto.communityId },
      select: { id: true },
    });
    if (!community) {
      throw new NotFoundException(`Community ${dto.communityId} not found.`);
    }

    return this.prisma.creditSpend.create({
      data: {
        userWawuId: dto.userWawuId,
        communityId: dto.communityId,
        creatorWawuId: dto.creatorWawuId,
        creditsSpent: 1,
      },
    });
  }

  /** Internal read helper — e.g. for a future creator-earnings rollup. */
  async listForCreator(creatorWawuId: string): Promise<CreditSpend[]> {
    return this.prisma.creditSpend.findMany({
      where: { creatorWawuId },
      orderBy: { spentAt: 'desc' },
    });
  }
}
