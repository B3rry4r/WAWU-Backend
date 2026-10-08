import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Server } from 'http';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ExecutionContext,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { WawuAuthGuard } from '../../common/guards/wawu-auth.guard';
import { TgifController } from '../tgif.controller';
import { TgifService } from '../tgif.service';
import {
  BOOK_DAYS,
  TgifContentService,
  callName,
  personalise,
} from '../content/tgif-content.service';
import {
  SHARE_IMAGE_BUSY_MESSAGE,
  ShareImageService,
  shareCardSvg,
} from '../share/share-image.service';
import type { TgifDayView } from '../content/tgif-day.type';

/**
 * HOME-09, round 2: what a reader is shown is clean (no em-dash, a proper
 * sentence with no name, never a 500 for an odd name claim) and the card's
 * busy path answers 503. Nothing here needs the database or a WAWU ID: the
 * route specs put a stand-in guard where the token check is.
 */

const EM_DASH = '—';

/** Every date of a leap year, 366 of them, as YYYY-MM-DD. */
function leapYear(): string[] {
  const out: string[] = [];
  const first = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 366; i += 1) {
    out.push(new Date(first + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const contentService = () =>
  new TgifContentService({
    get: (key: string) => (key === 'TGIF_SHARE_LINK' ? 'wawu/tgif' : undefined),
  } as unknown as ConfigService);

const textOf = (d: TgifDayView) => Object.values(d).filter(Boolean).join('\n');

/** Names a caller can have in a token claim, all of which mean "no usable first name". */
const NO_NAME: unknown[] = [
  undefined,
  null,
  '',
  '   ',
  '\u{1F600}',
  '\u0000\u0001',
  12345,
  0,
  true,
  {},
  { first: 'Ada' },
  [],
  ['Ada'],
  () => 'Ada',
];

describe('TGIF served text has no em-dash (D1)', () => {
  it('holds none in the book on disk, in any field of any of its 365 days, as a character or as an escape', () => {
    let fields = 0;
    BOOK_DAYS.forEach((_days, i) => {
      const file = path.join(
        __dirname,
        '../../../assets/tgif',
        `${String(i + 1).padStart(2, '0')}.json`,
      );
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toContain(EM_DASH);
      expect(raw.toLowerCase()).not.toContain('\\u2014');
      fields += 1;
    });
    expect(fields).toBe(12);
  });

  it('serves none on any day of a leap year, to a reader with a name or without', () => {
    const service = contentService();
    const days = leapYear();
    expect(days).toHaveLength(366);
    for (const date of days) {
      for (const name of ['Adaeze', null]) {
        const served = textOf(service.day(date, name));
        expect(served).not.toContain(EM_DASH);
        expect(served).not.toContain('{Name}');
      }
    }
  });

  it('draws none on the shared card of any day of a leap year', () => {
    const service = contentService();
    for (const date of leapYear()) {
      const day = service.day(date, null);
      const { svg } = shareCardSvg({
        date,
        verse: day.verse,
        reference: day.verseReference,
        link: day.shareLink,
      });
      expect(svg).not.toContain(EM_DASH);
    }
  });

  it('keeps the words of a verse that had a dash: only the mark between them changed', () => {
    const service = contentService();
    // 16 April is Romans 8:17 (NIV): "heirs, heirs of God", not "heirsheirs" and not a word gone.
    expect(service.day('2025-04-16', null).verse).toContain(
      'we are heirs, heirs of God and co-heirs with Christ',
    );
    expect(service.day('2025-04-19', null).verse).toContain(
      'Christ Jesus who died, more than that, who was raised to life, is at the right hand of God',
    );
    expect(service.day('2025-02-25', null).verse).toContain(
      'pleasing to God: this is your true and proper worship',
    );
  });
});

describe('TGIF with no usable first name reads as a proper sentence (D5)', () => {
  const startsInCapitals = (s: string) => {
    const first = [...s.replace(/^["'“‘]+/, '')][0];
    return (
      first !== undefined &&
      first === first.toUpperCase() &&
      first !== first.toLowerCase()
    );
  };

  it('starts the reality card in a capital on every day of a leap year, whatever the missing name looks like', () => {
    const service = contentService();
    let checked = 0;
    for (const date of leapYear()) {
      for (const name of NO_NAME) {
        const reality = service.day(date, callNameArg(name)).reality;
        expect(startsInCapitals(reality)).toBe(true);
        expect(reality).not.toMatch(/^you[,.]/);
        expect(reality).not.toMatch(/^[A-Za-z]+, (you|friend)\b/i);
        expect(reality).not.toContain('{Name}');
        checked += 1;
      }
    }
    expect(checked).toBe(366 * NO_NAME.length);
  });

  it('capitalises the three shapes the book has: a lowercase word, a name of Christ or God, a quoted word', () => {
    const service = contentService();
    // 15 February: "{Name}, Christ IS your life." was "you, Christ IS your life."
    expect(service.day('2025-02-15', null).reality).toMatch(
      /^Christ IS your life\./,
    );
    // 5 February: "{Name}, \"lavished.\" That word ..." keeps its quotation mark and capitalises the word in it.
    expect(service.day('2025-02-05', null).reality).toMatch(
      /^"Lavished\." That word/,
    );
    // 1 February: "{Name}, you didn't just get a ticket ..." starts with a capital.
    expect(service.day('2025-02-01', null).reality).toMatch(
      /^You didn't just get a ticket/,
    );
  });

  it('drops the address where it closes a sentence, so the sentence still ends', () => {
    expect(personalise('Breathe, {Name}. It is done.', null)).toBe(
      'Breathe. It is done.',
    );
    expect(personalise('Breathe, {Name}. It is done.', 'Ada')).toBe(
      'Breathe, Ada. It is done.',
    );
    const service = contentService();
    // The three days the book closes a sentence with the address.
    expect(service.day('2025-01-01', null).reality).toContain('Breathe. It');
    expect(service.day('2025-05-31', null).reality).toContain(
      'So breathe. You',
    );
    expect(service.day('2025-06-15', null).reality).toContain(
      "Open your heart's eyes. See",
    );
    for (const date of ['2025-01-01', '2025-05-31', '2025-06-15']) {
      expect(service.day(date, null).reality).not.toMatch(/, you\./);
      expect(service.day(date, 'Ada').reality).toMatch(/, Ada\. /);
    }
  });

  it('is unchanged for a reader with a name: Name, then the book as written', () => {
    const service = contentService();
    for (const date of leapYear()) {
      expect(service.day(date, 'Adaeze').reality.startsWith('Adaeze, ')).toBe(
        true,
      );
    }
  });
});

/** A claim is passed to the service as it came in the token: whatever it is. */
function callNameArg(claim: unknown): string | null {
  return claim as string | null;
}

describe('TGIF names that are not strings (D4)', () => {
  it('callName treats a number, boolean, object, array or function as no name', () => {
    for (const odd of NO_NAME) expect(callName(odd)).toBeNull();
    expect(callName('  Ngozi   Okonkwo ')).toBe('Ngozi');
  });

  describe('on the route', () => {
    let app: INestApplication;
    let firstName: unknown;

    const build = async (images?: Pick<ShareImageService, 'png'>) => {
      const standIn = {
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest<{ user: unknown }>();
          req.user = { sub: 'tgif-spec-user', firstName };
          return true;
        },
      };
      const base = Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true })],
        controllers: [TgifController],
        providers: [
          TgifContentService,
          ShareImageService,
          { provide: TgifService, useValue: {} },
        ],
      })
        .overrideGuard(WawuAuthGuard)
        .useValue(standIn);
      const builder = images
        ? base.overrideProvider(ShareImageService).useValue(images)
        : base;
      const moduleRef = await builder.compile();
      const created = moduleRef.createNestApplication();
      created.useGlobalFilters(new AllExceptionsFilter());
      created.useGlobalInterceptors(new ResponseInterceptor());
      await created.init();
      return created;
    };

    beforeAll(async () => {
      app = await build();
    });
    afterAll(async () => {
      await app?.close();
    });
    beforeEach(() => {
      firstName = 'Adaeze';
    });

    const day = async () => {
      const res = await request(app.getHttpServer() as Server).get(
        '/tgif/2026-09-25',
      );
      return res;
    };

    it('answers 200 with the no-name reading, never a 500, when the claim is a number, an object, an array or a boolean', async () => {
      firstName = undefined;
      const baseline = await day();
      expect(baseline.status).toBe(200);
      const none = (baseline.body as { data: TgifDayView }).data.reality;
      expect(none.startsWith('Adaeze')).toBe(false);
      for (const odd of [
        12345,
        0,
        true,
        {},
        { first: 'Ada' },
        [],
        ['Ada'],
        null,
      ]) {
        firstName = odd;
        const res = await day();
        expect(res.status).toBe(200);
        expect((res.body as { data: TgifDayView }).data.reality).toBe(none);
      }
    });

    it('still greets a reader whose claim is a string', async () => {
      firstName = 'Adaeze Obi';
      const res = await day();
      expect(res.status).toBe(200);
      expect(
        (res.body as { data: TgifDayView }).data.reality.startsWith('Adaeze, '),
      ).toBe(true);
    });

    it('answers 503 with the busy sentence when the card cannot get a drawing slot', async () => {
      const busy = await build({
        png: () =>
          Promise.reject(
            new ServiceUnavailableException(SHARE_IMAGE_BUSY_MESSAGE),
          ),
      });
      try {
        const res = await request(busy.getHttpServer() as Server).get(
          '/tgif/2026-09-25/share-image',
        );
        expect(res.status).toBe(503);
        expect(JSON.stringify(res.body)).toContain(SHARE_IMAGE_BUSY_MESSAGE);
        expect(JSON.stringify(res.body)).not.toContain(EM_DASH);
      } finally {
        await busy.close();
      }
    });
  });
});
