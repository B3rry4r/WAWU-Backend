import { Injectable } from '@nestjs/common';
import type { PaidDmCreatorEarning, PaidDmStatus } from './paid-dm-view.type';

/** The question rows a creator's earning is asked about. */
export interface EarningQuestionRef {
  id: string;
  flutterwaveTxRef: string;
  status: PaidDmStatus;
}

/**
 * Answers what the creator earns by a paid question (task INBOX-18). The
 * earning is wallet data (the held price, the creator's share, the daily
 * move) and the direct-message module cannot import the wallet module, so
 * the wallet module registers its answer here, the way `DmAnsweredHooks`
 * takes the release step. With nothing registered (a server without the
 * wallet module) no question carries an earning.
 */
export type CreatorEarningResolver = (
  creatorWawuId: string,
  questions: EarningQuestionRef[],
) => Promise<Map<string, PaidDmCreatorEarning>>;

@Injectable()
export class DmCreatorEarningHooks {
  private resolver: CreatorEarningResolver | null = null;

  register(resolver: CreatorEarningResolver): void {
    this.resolver = resolver;
  }

  /** The earning of each question that has one, by question id. */
  async resolve(
    creatorWawuId: string,
    questions: EarningQuestionRef[],
  ): Promise<Map<string, PaidDmCreatorEarning>> {
    if (!this.resolver || questions.length === 0) return new Map();
    return this.resolver(creatorWawuId, questions);
  }
}
