import { Injectable } from '@nestjs/common';
import {
  DOCUMENT_UPLOADS_AT_ONCE,
  DOCUMENT_UPLOAD_WAIT_MS,
  MSG,
} from './documents-config';
import { DocumentError } from './document-errors';

/**
 * Places for uploads (task NUV-03): an upload holds up to two 10 MB files in
 * memory, and the same again as the one request to Nuvion, so only a few run
 * at once. One past that waits in order up to DOCUMENT_UPLOAD_WAIT_MS for a
 * place, then is refused with `503 document_busy`. A place is taken before
 * the body is read and given back when the request ends, whatever it ends
 * in. Each waiter holds one timer, cleared when it gets its place.
 */
@Injectable()
export class DocumentUploadSlots {
  /** Places; a spec may change these. */
  max = DOCUMENT_UPLOADS_AT_ONCE;
  waitMs = DOCUMENT_UPLOAD_WAIT_MS;
  private active = 0;
  /** The most held at once since start (for specs). */
  peak = 0;
  private readonly waiting: Array<{
    go: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  /** A place, or the refusal. The function returned gives it back, once. */
  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        go: () => {
          clearTimeout(waiter.timer);
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(
            new DocumentError('document_busy', MSG.busy, {
              retryAfterSeconds: Math.max(1, Math.ceil(this.waitMs / 1000)),
            }),
          );
        }, this.waitMs),
      };
      this.waiting.push(waiter);
    });
  }

  private releaser(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.waiting.shift();
      // The place passes straight to the next in line; `active` is unchanged.
      if (next) next.go();
      else this.active -= 1;
    };
  }
}
