import { EXPO_MAX_PAYLOAD_BYTES, PUSH_TTL_SECONDS } from './push-config';

/** What the phone gets, as Expo's send endpoint takes it. */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  ttl: number;
}

/** The notification fields a push is made from. */
export interface PushSource {
  id: string;
  kind: string;
  title: string;
  body: string;
  actionHref: string | null;
  target: { targetKind: string; targetId: string } | null;
}

/**
 * The push for one notification: its own title and body (the words the list
 * shows, written once in `composeNotification`), and a `data` object the app
 * reads on a tap: the notification, its kind, where it opens and what it is
 * about. Nothing else rides along, and no token is in it.
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
  const message: ExpoMessage = {
    to: token,
    title: source.title,
    body: source.body,
    data,
    ttl: PUSH_TTL_SECONDS,
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
