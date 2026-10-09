import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DeliverFilesDto } from '../dto/legal-consultation.dto';
import { fileNameFromUrl } from '../legal-deliverables.service';
import { objectKeyFrom } from '../../storage/storage.service';

// The same pipe main.ts installs.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const run = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: DeliverFilesDto });

const GOOD = 'https://bucket.s3.example.com/legal/u1/abc.pdf?X-Amz=1';
const refused = async (body: unknown, word: string) => {
  let err: unknown;
  try {
    await run(body);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(BadRequestException);
  expect(JSON.stringify((err as BadRequestException).getResponse())).toContain(
    word,
  );
};

describe('LEGAL-03 round 4: deliverables input', () => {
  it('accepts a normal file', async () => {
    const out = (await run({
      files: [{ fileName: 'a.pdf', url: GOOD }],
    })) as DeliverFilesDto;
    expect(out.files).toHaveLength(1);
  });

  it.each([
    [[[]]],
    [[null]],
    [['x']],
    [[1]],
    [[true]],
    [[[[]]]],
    [[[{ fileName: 'a', url: GOOD }]]],
    [[{}]],
    [[{ fileName: 5, url: GOOD }]],
    [[{ fileName: 'a', url: {} }]],
    [[{ fileName: 'a', url: [GOOD] }]],
    [[{ fileName: ['a'], url: GOOD }]],
    [[{ fileName: 'a', url: GOOD, pages: 'x' }]],
    [[{ fileName: 'a', url: GOOD, pages: {} }]],
  ])('refuses files %j as a 400 naming files', async (files) => {
    await refused({ files }, 'files');
  });

  it.each([
    ['%00', 'https://b.example.com/legal/u/a%00.pdf'],
    ['double NUL', 'https://b.example.com/legal/u/a%2500.pdf'],
    ['lone surrogate', 'https://b.example.com/legal/u/a%ED%A0%80.pdf'],
    ['dotdot', 'https://b.example.com/legal/u/%2e%2e/x.pdf'],
    ['double dotdot', 'https://b.example.com/legal/u/%252e%252e/x.pdf'],
    ['bad escape', 'https://b.example.com/legal/u/%ff.pdf'],
    ['encoded slash dotdot', 'https://b.example.com/legal/u/..%2fx.pdf'],
    [
      'long key',
      'https://b.example.com/' + '%C3%A9'.repeat(100) + '/legal/u/a',
    ],
  ])('refuses a url with %s as a 400 naming url', async (_n, url) => {
    await refused({ files: [{ fileName: 'a', url }] }, 'url');
  });

  it('objectKeyFrom never throws and passes unsafe links through', () => {
    for (const v of [undefined, null, 5, {}, [], 'https://h/legal/%00']) {
      expect(() => objectKeyFrom(v as never)).not.toThrow();
    }
    const bad = 'https://b.example.com/legal/u1/a%00.pdf';
    expect(objectKeyFrom(bad)).toBe(bad);
    expect(
      objectKeyFrom('https://b.example.com/content/full/u1/a.pdf?x=1'),
    ).toBe('content/full/u1/a.pdf');
    expect(fileNameFromUrl('https://b.example.com/legal/u1/a%00.pdf')).toBe(
      'Document',
    );
  });
});
