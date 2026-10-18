import type { S3Client } from '@aws-sdk/client-s3';
import { deleteFromBucket } from '../bucket-delete';

/** A client whose delete answers (or throws) what the test hands it. */
function clientThat(error: Error | null): S3Client {
  return {
    send: () => (error === null ? Promise.resolve({}) : Promise.reject(error)),
  } as unknown as S3Client;
}

function http(status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(
    new Error('x'),
    { $metadata: { httpStatusCode: status } },
    extra,
  );
}

describe('deleteFromBucket', () => {
  it('a delete the bucket accepted is gone', async () => {
    expect(await deleteFromBucket(clientThat(null), 'b', 'k')).toEqual({
      result: 'gone',
    });
  });

  it('a 404 for the key is gone (the object is not there)', async () => {
    for (const name of ['NoSuchKey', 'NotFound', 'Error']) {
      const out = await deleteFromBucket(
        clientThat(http(404, { name })),
        'b',
        'k',
      );
      expect(out).toEqual({ result: 'gone' });
    }
  });

  // FIX-65 F5: a misnamed STORAGE_BUCKET answers 404 NoSuchBucket. Nothing
  // was deleted and nothing was checked, so it must not read as "gone" (the
  // purge would drop the row and leave the object).
  it('a 404 that names a missing BUCKET is failed, not gone', async () => {
    for (const extra of [
      { name: 'NoSuchBucket' },
      { name: 'Error', Code: 'NoSuchBucket' },
      { name: 'Error', code: 'NoSuchBucket' },
    ]) {
      const out = await deleteFromBucket(
        clientThat(http(404, extra)),
        'b',
        'k',
      );
      expect(out.result).toBe('failed');
    }
  });

  it('another refusal is failed and no answer at all is unknown', async () => {
    expect(
      (await deleteFromBucket(clientThat(http(403)), 'b', 'k')).result,
    ).toBe('failed');
    expect(
      (await deleteFromBucket(clientThat(new Error('timeout')), 'b', 'k'))
        .result,
    ).toBe('unknown');
  });
});
