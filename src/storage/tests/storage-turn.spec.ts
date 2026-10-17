import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, throwError, of } from 'rxjs';
import { StorageBusyInterceptor } from '../storage-busy.interceptor';
import {
  STORAGE_BUSY_RETRY_SECONDS,
  STORAGE_LOCK_WAITERS_PER_PERSON,
  StorageBusyException,
  inPersonsTurn,
  requestsWaitingFor,
} from '../storage-lock';

/**
 * ME-04 round 6: one person's requests take their turn in memory, holding no
 * connection, and a burst beyond the queue is refused at once. No database.
 */
describe('A person’s turn at the storage lock (ME-04 round 6)', () => {
  /** A step that stays open until `finish` is called. */
  function openStep() {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { done, finish };
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  /** A step that does something small and finishes at once. */
  const quick =
    <T>(then: () => T) =>
    () =>
      Promise.resolve().then(then);

  it('runs one request of a person at a time, in the order they came', async () => {
    const order: string[] = [];
    const first = openStep();
    const a = inPersonsTurn('p-order', async () => {
      order.push('a start');
      await first.done;
      order.push('a end');
    });
    const b = inPersonsTurn(
      'p-order',
      quick(() => order.push('b')),
    );
    const c = inPersonsTurn(
      'p-order',
      quick(() => order.push('c')),
    );
    await tick();
    expect(order).toEqual(['a start']);
    expect(requestsWaitingFor('p-order')).toBe(2);
    first.finish();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a start', 'a end', 'b', 'c']);
    expect(requestsWaitingFor('p-order')).toBe(0);
  });

  it('lets two wait behind the one that runs and refuses the next with 429', async () => {
    expect(STORAGE_LOCK_WAITERS_PER_PERSON).toBe(2);
    const first = openStep();
    const ran: string[] = [];
    const runs = [
      inPersonsTurn('p-cap', async () => {
        await first.done;
        ran.push('1');
      }),
      inPersonsTurn(
        'p-cap',
        quick(() => ran.push('2')),
      ),
      inPersonsTurn(
        'p-cap',
        quick(() => ran.push('3')),
      ),
    ];
    await tick();
    expect(requestsWaitingFor('p-cap')).toBe(2);

    const refused = inPersonsTurn(
      'p-cap',
      quick(() => ran.push('4')),
    );
    await expect(refused).rejects.toBeInstanceOf(StorageBusyException);
    const err = (await refused.catch(
      (e: unknown) => e,
    )) as StorageBusyException;
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toEqual({
      message: 'You have several uploads in progress. Try again in a moment.',
      reason: {
        code: 'storage_busy',
        retryAfterSeconds: STORAGE_BUSY_RETRY_SECONDS,
      },
    });
    expect(requestsWaitingFor('p-cap')).toBe(2);

    first.finish();
    await Promise.all(runs);
    expect(ran).toEqual(['1', '2', '3']);

    // The line is empty again: the next request is let in at once.
    await expect(
      inPersonsTurn(
        'p-cap',
        quick(() => 'ok'),
      ),
    ).resolves.toBe('ok');
  });

  it('never makes one person wait for another', async () => {
    const first = openStep();
    const held = inPersonsTurn('p-one', () => first.done);
    await tick();
    await expect(
      inPersonsTurn(
        'p-two',
        quick(() => 'two'),
      ),
    ).resolves.toBe('two');
    first.finish();
    await held;
  });

  it('passes on the turn when a request fails, and does not swallow the error', async () => {
    const first = openStep();
    const failing = inPersonsTurn('p-fail', async () => {
      await first.done;
      throw new Error('boom');
    });
    const next = inPersonsTurn(
      'p-fail',
      quick(() => 'next'),
    );
    await tick();
    first.finish();
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
    expect(requestsWaitingFor('p-fail')).toBe(0);
  });

  it('never refuses the second half of a step that already changed something', async () => {
    const first = openStep();
    const lead = inPersonsTurn('p-fin', () => first.done);
    const waiting = [1, 2].map((n) =>
      inPersonsTurn(
        'p-fin',
        quick(() => n),
      ),
    );
    await tick();
    expect(requestsWaitingFor('p-fin')).toBe(2);
    // A new first half is refused; a finishing one queues behind.
    await expect(
      inPersonsTurn(
        'p-fin',
        quick(() => 0),
      ),
    ).rejects.toBeInstanceOf(StorageBusyException);
    const finishing = inPersonsTurn(
      'p-fin',
      quick(() => 'done'),
      {
        finishing: true,
      },
    );
    await tick();
    expect(requestsWaitingFor('p-fin')).toBe(3);
    first.finish();
    await lead;
    await expect(Promise.all(waiting)).resolves.toEqual([1, 2]);
    await expect(finishing).resolves.toBe('done');
  });
});

describe('StorageBusyInterceptor (ME-04 round 6)', () => {
  const contextWith = (set: jest.Mock) =>
    ({
      switchToHttp: () => ({ getResponse: () => ({ set }) }),
    }) as unknown as ExecutionContext;

  it('adds Retry-After to the 429 and lets the same error go on', async () => {
    const set = jest.fn();
    const busy = new StorageBusyException();
    const handler: CallHandler = { handle: () => throwError(() => busy) };
    await expect(
      firstValueFrom(
        new StorageBusyInterceptor().intercept(contextWith(set), handler),
      ),
    ).rejects.toBe(busy);
    expect(set).toHaveBeenCalledWith(
      'Retry-After',
      String(STORAGE_BUSY_RETRY_SECONDS),
    );
  });

  it('leaves every other answer and error alone', async () => {
    const set = jest.fn();
    const other = new Error('not ours');
    await expect(
      firstValueFrom(
        new StorageBusyInterceptor().intercept(contextWith(set), {
          handle: () => throwError(() => other),
        }),
      ),
    ).rejects.toBe(other);
    await expect(
      firstValueFrom(
        new StorageBusyInterceptor().intercept(contextWith(set), {
          handle: () => of('fine'),
        }),
      ),
    ).resolves.toBe('fine');
    expect(set).not.toHaveBeenCalled();
  });

  it('asks for the throttle’s own wait', () => {
    // hub-throttlers.ts: the shortest window is one second.
    expect(STORAGE_BUSY_RETRY_SECONDS).toBe(1);
  });
});
