import type { NotificationKind } from '../notification/notification-event';
import { EXPO_MAX_PAYLOAD_BYTES, PUSH_TTL_SECONDS } from './push-config';

/**
 * What the phone gets, as Expo's send endpoint takes it.
 *
 * Default (agent), owner may override (lead ruling of 7 Oct 2026 leaves the
 * message fields to the builder):
 *  - `priority: 'high'`: every pushed kind is something the person acts on
 *    (money in, a refund, a paid question with a deadline, a join answer), and
 *    Android's normal priority may hold a push back until a sleeping phone
 *    wakes. Expo maps it to FCM high priority and APNs priority 10.
 *  - no `sound`: Settings Z2's "Sound" switch lives on the phone and is off
 *    until the person turns it on (BACKEND_GAPS G-260), and the Hub never
 *    learns it, so the push asks for no sound and the phone side (INBOX-21)
 *    decides.
 *  - no `channelId`: Android uses the app's default channel; the phone side
 *    (INBOX-21) owns the channels.
 */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  ttl: number;
  priority: 'high';
}

/** The notification fields a push is made from. */
export interface PushSource {
  id: string;
  kind: string;
  title: string;
  body: string;
  actionHref: string | null;
  target: { targetKind: string; targetId: string } | null;
  /** The piece's current title, for a kind whose push names it differently from the list. */
  pieceTitle?: string | null;
}

/**
 * Kinds whose push says less than the list, because the list body carries
 * words that must not reach a lock screen. `content_rejected` holds the
 * admin's free-text reason (lead ruling, 7 Oct 2026, VB-4): the push says the
 * piece was sent back, and the reason is read in the app.
 */
const PUSH_BODY: Partial<Record<NotificationKind, (s: PushSource) => string>> =
  {
    content_rejected: (s) =>
      s.pieceTitle
        ? `“${s.pieceTitle}” was sent back. Tap to see why.`
        : 'Your upload was sent back. Tap to see why.',
  };

/** True when the push for `kind` needs the piece's title looked up. */
export function needsPieceTitle(kind: string): boolean {
  return kind in PUSH_BODY;
}

/**
 * The push for one notification: its own title and body (the words the list
 * shows, written once in `composeNotification`, except a kind in PUSH_BODY),
 * and a `data` object the app reads on a tap: the notification, its kind,
 * where it opens and what it is about. Nothing else rides along, and no token
 * is in it.
 */
export function buildMessage(source: PushSource, token: string): ExpoMessage {
  const data: Record<string, unknown> = {
    notificationId: source.id,
    kind: source.kind,
  };
  if (source.actionHref) data.actionHref = source.actionHref;
  if (source.target) {
    data.target = {
      kind: source.target.targetKind,
      id: source.target.targetId,
    };
  }
  const words = PUSH_BODY[source.kind as NotificationKind];
  const message: ExpoMessage = {
    to: token,
    title: source.title,
    body: words ? words(source) : source.body,
    data,
    ttl: PUSH_TTL_SECONDS,
    priority: 'high',
  };
  return fitPayload(message);
}

const bytes = (m: ExpoMessage): number =>
  Buffer.byteLength(JSON.stringify(m), 'utf8');

/** Cuts the body, never the data the app needs to open the screen. */
function fitPayload(message: ExpoMessage): ExpoMessage {
  if (bytes(message) <= EXPO_MAX_PAYLOAD_BYTES) return message;
  let body = message.body;
  while (
    body.length > 1 &&
    bytes({ ...message, body }) > EXPO_MAX_PAYLOAD_BYTES
  ) {
    body = body.slice(0, Math.max(1, Math.floor(body.length * 0.8)));
  }
  return { ...message, body: body.trimEnd() };
}
