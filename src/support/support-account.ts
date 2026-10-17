import { deriveVerificationState } from '../common/verification/verification-state';
import type { ChatPerson } from '../chat/chat-view.type';

/**
 * The account every support thread is with (task SUPPORT-01, DECISIONS R-30).
 *
 * Support is not a person in WAWU ID: it has no sign-in, no wallet and no
 * profile. A support thread is an ordinary free chat (ChatConversation)
 * between the person and this one fixed id, so the inbox, the chat screen,
 * unread counts, read marks and the live updates all work for it with no
 * second message store. The id is a well-formed uuid no WAWU ID account can
 * hold (all zeros but the last three digits), so it can never be mistaken for
 * someone's account.
 */
export const SUPPORT_WAWU_ID = '00000000-0000-4000-8000-000000000a11';

/** The name the support side of a thread goes by: the app's own (R-69). */
export const SUPPORT_NAME = 'Who Made This?';

export function isSupportAccount(wawuId: string): boolean {
  return wawuId === SUPPORT_WAWU_ID;
}

/** The support side as a chat or inbox row draws it. */
export function supportPerson(): ChatPerson {
  return {
    wawuId: SUPPORT_WAWU_ID,
    name: SUPPORT_NAME,
    handle: null,
    avatarUrl: null,
    verification: deriveVerificationState(null),
    support: true,
  };
}
