import {
  compareShape,
  fingerprint,
  mergeShapes,
} from '../../test/protected-routes/shape';

/**
 * The comparison the protected route suite relies on. If this is wrong, the
 * suite can be green while a response changed under the web app, so the
 * cases below are the ones a careless refactor actually produces.
 */
describe('protected route response shapes', () => {
  const locked = fingerprint({
    statusCode: 200,
    message: 'OK',
    data: {
      id: 'a',
      price: 1500,
      tags: ['x'],
      owner: { handle: 'h' },
      items: [{ id: 'i', n: 1 }],
    },
  });

  it('passes the same structure with different values', () => {
    const now = {
      statusCode: 200,
      message: 'OK',
      data: {
        id: 'b',
        price: 9,
        tags: [],
        owner: { handle: 'other' },
        items: [
          { id: 'j', n: 2 },
          { id: 'k', n: 3 },
        ],
      },
    };
    expect(compareShape(locked, now)).toEqual([]);
  });

  it('fails a renamed key, naming both the missing and the new one', () => {
    const now = {
      statusCode: 200,
      message: 'OK',
      data: {
        id: 'a',
        priceNaira: 1500,
        tags: [],
        owner: { handle: 'h' },
        items: [],
      },
    };
    expect(compareShape(locked, now)).toEqual([
      'body.data.price: missing (locked key removed or renamed)',
      'body.data.priceNaira: not in the lock (response widened)',
    ]);
  });

  it('fails an added key: a widened response goes to the owner', () => {
    const now = {
      statusCode: 200,
      message: 'OK',
      data: {
        id: 'a',
        price: 1,
        tags: [],
        owner: { handle: 'h' },
        items: [],
        extra: true,
      },
    };
    expect(compareShape(locked, now)).toEqual([
      'body.data.extra: not in the lock (response widened)',
    ]);
  });

  it('fails a retyped value, including inside array elements', () => {
    const now = {
      statusCode: 200,
      message: 'OK',
      data: {
        id: 'a',
        price: '1500',
        tags: [],
        owner: { handle: 'h' },
        items: [{ id: 'i', n: '1' }],
      },
    };
    // Reported in the lock's key order, which is alphabetical.
    expect(compareShape(locked, now)).toEqual([
      'body.data.items[0].n: locked as number, now string',
      'body.data.price: locked as number, now string',
    ]);
  });

  it('fails a list that became an envelope, and an object that became a list', () => {
    expect(
      compareShape(fingerprint({ data: [{ id: 'a' }] }), {
        data: { items: [{ id: 'a' }] },
      }),
    ).toEqual(['body.data: locked as an array, now an object']);
    expect(
      compareShape(fingerprint({ data: { id: 'a' } }), { data: [{ id: 'a' }] }),
    ).toEqual(['body.data: locked as an object, now an array']);
  });

  it('tolerates null for a typed value, and anything where only null was seen', () => {
    expect(
      compareShape(locked, { statusCode: 200, message: 'OK', data: null }),
    ).toEqual([]);
    expect(
      compareShape(fingerprint({ v: null }), { v: { any: 'thing' } }),
    ).toEqual([]);
  });

  it('merges array elements so an optional key is not reported missing', () => {
    const shape = fingerprint([{ id: 'a', note: 'x' }, { id: 'b' }]);
    expect(shape).toEqual([{ id: 'string', 'note?': 'string' }]);
    expect(compareShape(shape, [{ id: 'c' }])).toEqual([]);
    expect(compareShape(shape, [{ id: 'c', other: 1 }])).toEqual([
      'body[0].other: not in the lock (response widened)',
    ]);
  });

  it('pins only the values of a map whose keys are data', () => {
    const shape = fingerprint({ byKind: { video: 2, pdf: 1 } }, ['byKind']);
    expect(shape).toEqual({ byKind: { $map: 'number' } });
    expect(compareShape(shape, { byKind: { audio: 4 } })).toEqual([]);
    expect(compareShape(shape, { byKind: { audio: 'four' } })).toEqual([
      'body.byKind.audio: locked as number, now string',
    ]);
  });

  it('keeps structurally different alternatives apart when merging', () => {
    const merged = mergeShapes('string', { id: 'string' });
    expect(compareShape(merged, 'x')).toEqual([]);
    expect(compareShape(merged, { id: 'y' })).toEqual([]);
    expect(compareShape(merged, 3)).toHaveLength(1);
  });
});
