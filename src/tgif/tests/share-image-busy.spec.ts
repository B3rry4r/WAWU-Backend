import { ServiceUnavailableException } from '@nestjs/common';

/**
 * HOME-09, round 2 (mutant B10): the shared card is drawn two at a time, a
 * third request waits for a slot, and one that finds none in ten seconds is
 * refused with 503 and the busy sentence. The renderer is held by this spec so
 * the slots stay full for as long as the spec wants.
 */

type Image = { asPng: () => Buffer };
interface Held {
  resolve: (image: Image) => void;
  svg: string;
}
const mockHeld: Held[] = [];
jest.mock('@resvg/resvg-js', () => ({
  renderAsync: jest.fn(
    (svg: string) =>
      new Promise<Image>((resolve) => {
        mockHeld.push({ resolve, svg });
      }),
  ),
}));

import { renderAsync } from '@resvg/resvg-js';
import {
  SHARE_IMAGE_BUSY_MESSAGE,
  ShareImageService,
} from '../share/share-image.service';

const WAIT_MS = 10_000;
const png = (tag: string) => ({ asPng: () => Buffer.from(tag) });
const card = (day: string) => ({
  date: `2026-${day}`,
  verse: `verse ${day}`,
  reference: 'John 3:16 (NIV)',
  link: null,
});
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('the shared card under load', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHeld.length = 0;
    (renderAsync as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('draws two cards at once, makes a third wait, and refuses it with 503 after ten seconds', async () => {
    const service = new ShareImageService();
    const first = service.png(card('01-05'));
    const second = service.png(card('01-06'));
    await settle();
    expect(renderAsync).toHaveBeenCalledTimes(2);

    const third = service.png(card('01-07'));
    const outcome = jest.fn<void, [unknown]>();
    void third.then(
      () => {
        outcome('drawn');
      },
      (error: unknown) => {
        outcome(error);
      },
    );
    await settle();
    // Both slots are full: the third has not been handed to the renderer.
    expect(renderAsync).toHaveBeenCalledTimes(2);
    expect(outcome).not.toHaveBeenCalled();

    jest.advanceTimersByTime(WAIT_MS - 1);
    await settle();
    expect(outcome).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await settle();
    expect(outcome).toHaveBeenCalledTimes(1);
    const refusal = (outcome.mock.calls as unknown[][])[0][0];
    expect(refusal).toBeInstanceOf(ServiceUnavailableException);
    expect((refusal as ServiceUnavailableException).getStatus()).toBe(503);
    expect((refusal as ServiceUnavailableException).message).toBe(
      SHARE_IMAGE_BUSY_MESSAGE,
    );
    // Still never drawn: a refused request does not take a slot late.
    expect(renderAsync).toHaveBeenCalledTimes(2);

    mockHeld[0].resolve(png('a'));
    mockHeld[1].resolve(png('b'));
    await expect(first).resolves.toEqual(Buffer.from('a'));
    await expect(second).resolves.toEqual(Buffer.from('b'));
  });

  it('forgets a refused card, leaves no stale turn in the queue, and draws it when a slot is free', async () => {
    const service = new ShareImageService();
    const first = service.png(card('02-05'));
    const second = service.png(card('02-06'));
    await settle();
    const refused = service.png(card('02-07')).catch((e: unknown) => e);
    await settle();
    jest.advanceTimersByTime(WAIT_MS);
    expect(await refused).toBeInstanceOf(ServiceUnavailableException);

    // One slot frees. The refused request's turn must not be taken by a ghost.
    mockHeld[0].resolve(png('a'));
    await first;
    await settle();
    expect(renderAsync).toHaveBeenCalledTimes(2);

    const again = service.png(card('02-07'));
    await settle();
    expect(renderAsync).toHaveBeenCalledTimes(3);
    mockHeld[2].resolve(png('c'));
    await expect(again).resolves.toEqual(Buffer.from('c'));
    mockHeld[1].resolve(png('b'));
    await second;
  });

  it('serves a card drawn once to a second caller of the same day without drawing it again', async () => {
    const service = new ShareImageService();
    const one = service.png(card('03-05'));
    const two = service.png(card('03-05'));
    await settle();
    expect(renderAsync).toHaveBeenCalledTimes(1);
    mockHeld[0].resolve(png('x'));
    expect(await one).toBe(await two);
  });
});
