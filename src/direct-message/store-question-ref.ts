import type { Prisma } from '../../generated/prisma/client';

/**
 * A paid question bought in the app store (STORE-QUESTION, R-101) is a
 * `DirectMessage` whose reference is `store:<StorePurchase id>`, as a question
 * paid from the wallet's is `wallet:<payment id>`. The money is not in a
 * Flutterwave charge and not in a wallet hold: it is a store sale, and the
 * store module alone decides what happens to it (the creator's earning when
 * they answer, a question credit for the asker when they do not, a take-back
 * when the store pays the asker back). So the web's Flutterwave sweeps leave
 * these rows alone, exactly as they leave the wallet's.
 */
export const STORE_QUESTION_REF_PREFIX = 'store:';

/** The reference the question bought by store purchase `purchaseId` carries. */
export const storeQuestionRef = (purchaseId: string): string =>
  `${STORE_QUESTION_REF_PREFIX}${purchaseId}`;

/** True for a question bought in a store. */
export const isStoreQuestionRef = (ref: string): boolean =>
  ref.startsWith(STORE_QUESTION_REF_PREFIX);

/** The store purchase a question's reference names, or null for any other reference. */
export function purchaseIdOfStoreRef(ref: string): string | null {
  return isStoreQuestionRef(ref)
    ? ref.slice(STORE_QUESTION_REF_PREFIX.length)
    : null;
}

/**
 * What a question carries in `refundReference` when a store refund of its
 * purchase withdrew it before the creator answered. The creator did nothing
 * wrong, so such a question is not a miss in their standing (INBOX-09). A
 * Flutterwave refund id is never this value.
 */
export const STORE_REFUND_MARK = 'store_refund';

/**
 * A question the store refund withdrew is left out. `refundReference` is null
 * on most rows, and a `not` filter alone would drop those, so null is kept.
 */
export const NOT_WITHDRAWN_BY_STORE_REFUND: Prisma.DirectMessageWhereInput = {
  OR: [
    { refundReference: null },
    { refundReference: { not: STORE_REFUND_MARK } },
  ],
};
