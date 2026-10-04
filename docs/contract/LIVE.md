# Live updates for chat (INBOX-02)

How a phone sees a chat message, a read tick or a room message without a
refresh. One WebSocket carries what happens; one route catches up on what was
missed. Both are new and additive: nothing the web or the dashboard calls
changes.

The socket is not part of `contract/openapi.json` (OpenAPI has no WebSocket).
The route is: `GET /live/catch-up`. The event shapes are the TypeScript types
in `src/live/live-event.type.ts`.

## 1. Why a WebSocket, and why Postgres carries it between instances

- **WebSocket, not SSE or polling.** Chat is two-way and a phone's connection
  comes and goes; one socket per signed-in phone serves the inbox and every
  open chat. The raw WebSocket protocol (`ws`) is used, not Socket.IO:
  Socket.IO needs sticky sessions and its own client library, and Expo's
  `WebSocket` speaks the plain protocol.
- **Through nginx as it is.** `deploy/install-services.sh` already forwards
  `Upgrade` and `Connection` and sets a 120 s read timeout. The server pings
  every 30 s, so a quiet socket never reaches that timeout.
- **No new service.** Events reach every Hub instance through Postgres
  `LISTEN` / `NOTIFY` on the database the Hub already has, not Redis.
  Nothing in `deploy/` or the code ran Redis, and the droplet has none (the
  task's "Redis on the droplet" is an owner input). The signal is only which
  row changed (`src/live/live-signal.type.ts`); each instance reads the row
  for the people connected to it. `LISTEN` needs a direct connection: the
  `25060` port in `deploy/README.md`, not a transaction-mode pool port.
  If the owner later puts Redis on the droplet, the one thing to swap is
  `LivePublisher` and `LiveListener`; nothing else knows how events travel.

## 2. The socket

`wss://api.<domain>/api/hub/live`

**Signing in** uses the same WAWU ID access token as every route, verified
the same way (RS256, WAWU ID's JWKS, issuer and audience when configured).
Either:

- `Authorization: Bearer <token>` on the upgrade request (the phone app), or
- the first frame `{"type":"auth","token":"<token>"}` (browsers).

A token in the URL is never read. A socket with no valid token within 5 s is
closed `4401 auth_timeout`. A new `auth` frame may be sent at any time; it
must be the same person (`4403` if not). A socket whose token runs out is
closed `4401 token_expired`: the app reconnects with a fresh token. Send a
new `auth` frame before expiry to stay connected.

Once accepted the server sends `{"type":"ready","wawuId","cursor"}`. The
cursor is where "now" is: a client with no cursor yet holds this one.

**Client frames.** Only `auth` and `{"type":"ping"}` (answered `{"type":"pong"}`).
Anything else closes the socket. Frames are limited to 8 KB.

**Nothing is subscribed.** A person receives the events of every chat and
community they are in. Who may receive an event is decided from the database
for each event, so a block, a leave or a removal takes effect on sockets that
are already open:

| Event | Goes to |
|---|---|
| `chat.message` | the two people in the chat, never once either has blocked the other |
| `chat.read` | the other person (not when blocked) and the reader's own other phones |
| `community.message` | the host and members whose status is `joined`; not anyone who has blocked the sender or been blocked by them |

A person may hold 8 sockets; the 9th closes the oldest with `4409`.

**Events** (all carry `cursor`):

```
{ type: 'chat.message',      cursor, message: ChatMessage }
{ type: 'chat.read',         cursor, chatId, readerWawuId, mine, lastReadAt, lastReadMessageId }
{ type: 'community.message', cursor, communityId, message: CommunityMessage }
```

`message` is the same shape the REST routes return, from the viewer's side
(`mine`, `readState`, `clientMessageId` only on the sender's own copy).
A `chat.read` does not carry an unread count: the phone that read refetches
`GET /chats/:chatId` if it wants the number. Money-request events join this
list when the money-request task writes them (BACKEND_GAPS).

**Close codes the app reconnects on:** `1001` (the server is restarting),
`4401`, `4409`, `4503`. `4503` means the server lost its own feed and closed
every socket so that no client waits on events that cannot arrive; a socket is
not accepted (HTTP 503 on the upgrade) until the feed is back.

## 3. Reconnecting without losing anything: `GET /live/catch-up`

`GET /live/catch-up?cursor=<cursor>&limit=<1..100, default 50>` (bearer token)

```
{ events: LiveEvent[],   // oldest first
  cursor: string,        // the cursor to hold next
  hasMore: boolean }     // true: send `cursor` straight back for the next page
```

The app, on every reconnect and whenever it returns to the foreground:

1. opens the socket and waits for `ready`;
2. calls `catch-up` with the newest cursor it holds, and again while
   `hasMore` is true;
3. drops by id any message it already has. Read marks are state, so
   applying one twice is harmless.

Doing it in this order (socket first) leaves no gap: whatever happens after
the socket is up arrives on it, and whatever happened before is in the
catch-up. With no `cursor` the answer is empty and `cursor` is "now".

The cursor is a point in time. A catch-up reads 10 s behind the cursor it is
given, because a message is stamped when its transaction starts and can
commit after a later one has already been pushed; the id check in step 3
removes the repeats. A cursor that continues a page is read exactly.

What it returns: new messages in the caller's chats and in the communities
they are in, and the read marks the other person moved (one event per chat,
the latest mark). It leaves out chats where either person has blocked the
other and community messages from anyone on either side of a block, as the
socket does. The caller's own read marks are not included (the phone that
read already knows); unread counts come from `GET /chats`.
