import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/**
 * What a delete in the bucket came to (ME-04 round 5).
 *
 * - `gone`: the object is not in the bucket any more (deleted, or already
 *   absent: S3 answers a delete of a missing key with success, and a 404 is
 *   the same thing).
 * - `failed`: the bucket answered with an error, so the object was not
 *   deleted and the caller may go back to what it was before.
 * - `unknown`: no answer came (the request timed out, the connection broke).
 *   The delete may still be carried out, so the caller must not hand the key
 *   to anyone else: the row stays given up and the sweep settles it.
 */
export type DeleteOutcome =
  { result: 'gone' } | { result: 'failed' | 'unknown'; error: unknown };

/**
 * Deletes `key`. Call it with no transaction open and no lock held: the
 * client's request timeout (storage.service.ts) bounds it, but it is still a
 * network call.
 */
export async function deleteFromBucket(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<DeleteOutcome> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { result: 'gone' };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404) return { result: 'gone' };
    return { result: status === undefined ? 'unknown' : 'failed', error };
  }
}
