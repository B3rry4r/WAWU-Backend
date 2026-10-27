/**
 * The rules of a paid question bought in a store that need no database
 * (STORE-QUESTION, R-101 points 2, 4, 5 and 6).
 */

/** The scope of a credit a question made: it pays for a paid question and for nothing else. */
export const QUESTION_CREDIT_SCOPE = 'question' as const;

export type CreditScope = typeof QUESTION_CREDIT_SCOPE | null;

/** What a question's earning is called in the creator's earnings. */
export const QUESTION_EARNING_TITLE = 'Paid question';

/** The longest question, as the wallet path allows. */
export { MAX_QUESTION_LENGTH } from '../../direct-message/wallet/paid-dm-wallet-rules';

export const QUESTION_TEXT_MISSING =
  'Write your question before you pay for it.';
export const QUESTION_ONLY = 'Only a question carries the words of a question.';

/**
 * The scope a credit must have to pay for a purchase of this kind: a question
 * is paid with a question credit, and a piece, a tip or a pass with a credit
 * that has no scope (every credit made before questions existed). A question
 * credit never pays for a piece, a tip or a pass, and an unscoped credit never
 * pays for a question (R-101 point 6: the credit is for asking a question).
 */
export function creditScopeFor(kind: string): CreditScope {
  return kind === 'question' ? QUESTION_CREDIT_SCOPE : null;
}
