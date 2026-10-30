# A cover picture on a piece (CONTENT-COVER, R-114)

Owner, 30 Oct 2026: every piece can carry a cover picture of its own. Until now the Hub kept one public file per piece
(`previewAssetUrl`), an mp4 clip for a video or a course, an mp3 or wav clip for audio and a pdf extract for a pdf, so a
card for those formats could only show a mark. A cover is a picture the creator uploads for the listing, whatever its
format. It is optional, additive and never changes `thumbnailUrl` or `previewAssetUrl`.

## Uploading one

`POST /uploads/presign` with `folder: "content/cover"`. Accepted: jpeg, png, webp (no gif, no svg), at most 5 MB. The file
is counted in the person's storage like any upload, and a person who may not publish yet is refused as for any content
file. A cover is not a product, so it takes no free place. The answer is the usual presign answer; its `key` (or
`fileUrl`) is what a listing names.

## Setting, replacing and removing it (owner only)

| Call | Field | Meaning |
|---|---|---|
| `POST /content` | `coverAsset` | the key (or `fileUrl`) of a cover the caller uploaded; left out, no cover |
| `POST /product-drafts/{id}/publish` | `coverAsset` | the same, on the draft publish |
| `PATCH /content/{id}` | `coverAsset` | a new key replaces the cover and the old file is deleted; `null` takes it off (the file is deleted); left out, the cover stays |

A key that is not the caller's own cover upload (another person's, another folder, a gif, an upload that was given up) is
`400`. A piece that is rejected keeps its cover, so the creator can send it again.

## Reading it: `coverUrl`

A new nullable field, `coverUrl`: a fresh link to the cover, `null` when the piece has none. The Hub stores the key, never
a link, and signs a new link on every read. Nothing else changes: `thumbnailUrl`, `previewAssetUrl` and every existing
field keep their values.

Views that carry it:

- The piece (`ContentPieceResponse`: `GET /content`, `GET /content/{id}`, `GET /content/mine`, `GET /content/purchases`,
  `POST /content`, `PATCH /content/{id}`), the feed (`FeedItem`), My content (`MyContentItem`), the creator cards' works
  (`CardWork`), search content rows, the parent course on a lesson (`ParentCourse`), the pieces a person saved
  (`SavedContentView`) and bought (`PurchasedPieceView`), the pay sheet's quote (`UnlockWalletQuoteView`), and the earnings
  rows (`EarningContentView`, `StoreEarningWaitingView`).
- The admin review: `GET /admin/content/{id}/cover` answers `{ "coverUrl": string | null }`, a link good for 15 minutes,
  so a reviewer sees the picture they approve with the piece. It is its own route: `queue` and `:id` answer as they did.

**The header rule.** The routes in `.pipeline/protected-registry.json` (the website calls them) and the dashboard's routes
answer byte for byte as before unless the request carries `X-Wawu-Client: app` (CONVENTIONS section 3a). With the header
they gain `coverUrl`; without it the field is absent. The routes only the app calls (the feed, My content, `/me/*`, the
pay sheet's quote, the earnings rows) always carry it.

## Account deletion, data export, moderation

Deleting an account deletes its covers, except the covers of pieces a buyer paid for that were live when the deletion
began (kept for the buyers, like the preview). The data export lists a person's covers with their other files. A cover is
reviewed with its piece.

## Migration

`20261226090000_content_cover` adds the nullable column `ContentPiece.coverKey` and nothing else; every existing row keeps
NULL. Its `rollback.sql` refuses while any piece has a cover, because dropping the column would orphan the files.
