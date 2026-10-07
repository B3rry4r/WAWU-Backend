# Phone push (INBOX-03)

How a notification reaches a phone through Expo's push service, and the two
routes the app uses to say which phone is whose. All of it is new and
additive: no existing route, table or response changes.

The phone side (permission, token, tap) is INBOX-21. Android push needs the
owner's FCM credentials uploaded to Expo (owner input); V10 runs on a real
Android phone only (DECISIONS R-24).

## 1. Routes

Both need the WAWU ID access token. `push-tokens` is a first segment no other
controller declares.

| Route | Body | Answer |
|---|---|---|
| `POST /push-tokens` | `expoPushToken` (`ExponentPushToken[...]` or `ExpoPushToken[...]`), `platform` (`android` or `ios`), optional `deviceId` (200 chars), `deviceLabel` (100 chars) | `200 {registered: true}` |
| `DELETE /push-tokens` | `expoPushToken` | `200 {removed: boolean}` |

- **Register on every start.** It is idempotent: the same phone again keeps one
  row and moves `lastSeenAt`. The owner always comes from the access token.
- **One phone, one person.** The token is unique. When somebody else signs in
  on the phone and registers, the row moves to them, and what was written for
  the first person before that moment is never pushed to the second.
- **Remove on sign-out.** `DELETE` takes the token in the body, never the URL,
  so it stays out of access logs. Removing a token that is not the caller's, or
  that is not there, removes nothing and answers `removed: false`: the route
  cannot show whose phone a token is.
- **A cap per person** (`PUSH_MAX_TOKENS_PER_USER`, provisional, 10). Over it, the
  phone seen longest ago is dropped, so a new phone never fails to register.
- **A token is never returned and never logged.**
- A token Expo calls dead (`DeviceNotRegistered`) is disabled and never sent
  to again; registering it again (the app still holding it) makes it live. A
  disabled token is deleted after 30 days.

## 2. What is pushed

The sender sits behind `NotificationService`. It writes no notification and
decides nothing about categories by itself:

- A notification is pushed only if the service wrote it. A kind whose Z3
  switch is off is never written, so it is never pushed (`emit()` returns
  null).
- The same switch is read again just before the send (`NotificationService.
  isSwitchOff`), so a switch turned off a second ago is honoured.
- `src/push/push-policy.ts` decides every kind (`send` or `hold`) in a Record
  over the whole vocabulary: a kind added without a decision does not compile.

| Pushed | Switch |
|---|---|
| `sale`, `tip_received` | Money in (`moneyIn`) |
| `dm_refunded` | Refunds (`refunds`) |
| `new_follower` | New followers (`newFollowers`) |
| `dm_deadline` | Paid questions (`dmReminders`) |
| `dm_received` | Paid questions (`dmReminders`), for push only (the list is unchanged, G-24) |
| `content_published`, `content_rejected`, `review_received` | Reviews (`contentReviews`) |
| `community_join_approved`, `community_join_declined` | none (G-32) |

**Held, not pushed** (they stay in the in-app list): `paid_dm_warning`,
`paid_dm_paused`, `credits_low`, `kyc_verified`, `verify_reminder`, `campaign`.
No agreed switch covers them. BACKEND_GAPS G-233 asks the owner for each.

## 3. The push

Expo's `send` message: `to`, `title`, `body`, `ttl`, and `data`:

```json
{
  "notificationId": "uuid",
  "kind": "community_join_approved",
  "actionHref": "/communities/<id>",
  "target": { "kind": "community", "id": "<id>" }
}
```

`title` and `body` are the notification's own words (`composeNotification`);
nothing is composed for push. `actionHref` and `target` are present only when
the notification has them. A body that would pass Expo's 4096 byte payload limit is
shortened; `data` never is. INBOX-21 reads `data` on a tap.

## 4. How it runs

Every hub instance runs the sender every 10 seconds (`PushSweepService`). No
instance needs to agree with another; each step is claimed in Postgres.

1. **Enqueue.** A notification of a pushed kind written in the last 15 minutes
   becomes one `PushDelivery` per live phone its recipient has owned since
   before it was written. `UNIQUE(notificationId, pushTokenId)` with
   `ON CONFLICT DO NOTHING` makes two instances, or two passes, one delivery.
   The notification table is the outbox: nothing in `emit()` changed.
2. **Send.** Due deliveries are claimed with `FOR UPDATE SKIP LOCKED`, checked
   once more (token still there, still that person's, switch still on, not
   already read), and sent in chunks of at most 100 messages. Expo's ticket is
   kept. A 429, 5xx or no connection is retried with a doubling delay up to a
   limit; Expo refusing the request fails it; an answer that was lost (timeout,
   unreadable) fails it and is never sent again, because Expo may have taken it
   and a missing push beats a double one.
3. **Receipts.** About a minute after a send, then every five minutes while Expo
   has none, up to a day, the receipt ids are asked for (at most 300 a request).
   `ok` marks the delivery `delivered`. `DeviceNotRegistered` disables the
   token (only if the person has owned it since before that send).
   `InvalidCredentials` (the FCM key is not uploaded to Expo) is logged as an
   error. The claim moves the due time in the same statement, so parallel jobs
   never read the same delivery twice.

A push failure never fails a notification or a request: nothing runs inside
either. A send held by an instance that stopped mid-send is failed after two
minutes.

## 5. Configuration

| Variable | Meaning |
|---|---|
| `PUSH_ENABLED` | `true` turns the sender on. Anything else, or unset, is off: nothing is enqueued, sent or fetched. **Off by default**, so staging and a developer machine with a copy of production never push. |
| `EXPO_ACCESS_TOKEN` | Optional. Sent as `Authorization: Bearer` when the Expo project turned on enhanced push security. |
| `EXPO_PUSH_BASE_URL` | Optional, default `https://exp.host`. Anything but `https://exp.host` or a local address stops the server at boot. |

The figures that are not Expo's own are `PROVISIONAL(...)` in
`src/push/push-config.ts`.

## 6. What this was checked against

Expo's documentation site and push hosts are not reachable from the sandbox
this was built in (403 from the egress policy), so no real Expo answer was
captured. The send, ticket, receipt and error shapes, the 100 and 300 limits
and the token format are taken from Expo's server SDK (`expo-server-sdk`
7.2.0). The specs run against a local stand-in server that answers with
those shapes (`src/push/tests/expo-stand-in.ts`). It is a stand-in, not Expo.
