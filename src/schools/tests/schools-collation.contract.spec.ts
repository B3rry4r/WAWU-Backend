import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SearchResponseModule } from '../../search-response/search-response.module';

/**
 * FIX-27: the schools list is in one order on every database.
 *
 * A text column sorts by the collation its database was made with (CI's
 * `postgres:16` image sorts `en_US.utf8`, a droplet or a laptop may sort
 * `C.UTF-8`, an ICU database sorts yet another way), so an order left to the
 * column moves between machines: the same schools come in a different order,
 * and a test written against one machine fails on another. The list and its
 * cursor now both say the order in the query itself:
 *
 *   A to Z ignoring ASCII case, by code point; then the exact name, by code
 *   point; then the id.
 *
 * This spec writes that sentence out in plain code (`expectedOrder`, no SQL,
 * no database) and checks the API against it, so it gives the same answer
 * whatever the database sorts like. Run it on a `C.UTF-8` database, on an ICU
 * one and on `en_US.utf8` (npm run test:contract does, in CI).
 *
 * The names are chosen to be sorted differently by those databases:
 * lower-case first letters, hyphens and spaces and apostrophes, accents, a
 * flag emoji (with its variation selector), a Han character outside the BMP
 * (glibc gives it no weight at all), a control character, a soft hyphen,
 * names equal but for case, and names that are the same exactly.
 */
const PLACE = 'S27coll';
const LOC = `${PLACE}, Yaba`;
const uid = (n: number) =>
  `27000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const cur = (name: string, id: string) =>
  Buffer.from(JSON.stringify([name, id])).toString('base64url');

/** A flag, as three UTF-16 units (U+1F3F3 U+FE0F). */
const FLAG = '\u{1F3F3}️';
/** A Han ideograph past U+1F3F3 in code point order; glibc ignores it. */
const LATER = '\u{20000}';

/** Ordinary names an admin would type, mixed the way real ones are. */
const ORDINARY = [
  'Yaba College of Technology',
  'Lagos Business School',
  'Lagos Studios',
  'Pan-Atlantic University',
  'Pan Atlantic Hub',
  'Co-Creation Hub',
  'CcHub Design Lab',
  'iLearn Academy',
  'Ife Creative Arts',
  'eHealth Africa Institute',
  'uLesson Studio',
  'ALX Africa',
  'altSchool Africa',
  'Andela Learning Community',
  "D'Lite Beauty School",
  'Dee-Jay Music School',
  'Dee Jay Studio',
  "St. Mary's Vocational Centre",
  'St Luke Institute',
  'Stanbic Business Hub',
  '3MTT Nigeria',
  '100 Women Coders',
  'Zuri Training',
  'zeta Craft School',
];
/** Names the databases disagree about. */
const AWKWARD = [
  'École Hôtelière',
  'Ecole Polytechnique',
  'Ünal Academy',
  '学校 Academy',
  `${FLAG} Flag School`,
  `${LATER} Outside The Plane`,
  `${FLAG}${FLAG}${FLAG}`,
  `${FLAG}${FLAG}${LATER}`,
  'Ignore\u0001Control',
  'IgnoreControl',
  'Soft­Hyphen School',
  'SoftHyphen School',
  'case twin',
  'Case Twin',
  'CASE TWIN',
  'Twin School',
  'Twin School',
  'Twin School',
];

type Item = { id: string; name: string };
type Page = { items: Item[]; nextCursor: string | null };

/** UTF-8 byte order is code point order; JavaScript's own `<` is not. */
const byCodePoint = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The order the list promises, with no database in it. */
const expectedOrder = (rows: Item[]): Item[] =>
  [...rows].sort(
    (a, b) =>
      byCodePoint(asciiLower(a.name), asciiLower(b.name)) ||
      byCodePoint(a.name, b.name) ||
      byCodePoint(a.id, b.id),
  );

describe('The schools list is in one order on every database (FIX-27)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let made: Item[];
  const get = (p: string) =>
    request(app.getHttpServer() as Parameters<typeof request>[0]).get(
      `/api/hub${p}`,
    );
  const page = async (qs: string): Promise<Page> =>
    (
      (await get(`/schools?q=${PLACE}&${qs}`).expect(200)).body as {
        data: Page;
      }
    ).data;
  const cleanUp = () =>
    prisma.school.deleteMany({ where: { location: { startsWith: PLACE } } });
  const walk = async (limit: number): Promise<Item[]> => {
    const seen: Item[] = [];
    let c: string | null = null;
    do {
      const p: Page = await page(`limit=${limit}${c ? `&cursor=${c}` : ''}`);
      expect(p.items.length).toBeLessThanOrEqual(limit);
      seen.push(...p.items);
      c = p.nextCursor;
    } while (c);
    return seen;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        SearchResponseModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanUp();
    // Inserted in a scrambled order, with ids that fall as the list goes on,
    // so neither insertion order nor id order is the answer.
    const names = [...ORDINARY, ...AWKWARD];
    expect(names.length).toBeLessThanOrEqual(50);
    made = [];
    for (let i = 0; i < names.length; i++) {
      const k = (i * 17 + 5) % names.length;
      const id = uid(0xf000 - k * 3);
      await prisma.school.create({
        data: {
          id,
          name: names[k],
          category: 'vocational',
          location: LOC,
          about: 'A school this spec creates and removes.',
          reportEmail: 'enrolments@school.example.com',
        },
      });
      made.push({ id, name: names[k] });
    }
    expect(new Set(made.map((m) => m.id)).size).toBe(names.length);
  }, 120_000);

  afterAll(async () => {
    await cleanUp();
    await app.close();
  });

  it('one big page is in the promised order: A to Z ignoring ASCII case, by code point, then exact name, then id', async () => {
    const all = (await page('limit=50')).items;
    expect(all).toHaveLength(made.length);
    expect(all.map((s) => s.id)).toEqual(expectedOrder(made).map((s) => s.id));
  });

  it('a walk at every page size sees each school once, in the order of one big page', async () => {
    const big = (await page('limit=50')).items.map((s) => s.id);
    for (const limit of [1, 2, 3, 4, 5, 7, 10, 13, 20, 39, 50]) {
      const seen = (await walk(limit)).map((s) => s.id);
      expect(new Set(seen).size).toBe(seen.length); // none twice
      expect(seen).toEqual(big); // none missing, same order
    }
  });

  it('a cursor at any school gives exactly the schools after it in that order', async () => {
    const all = expectedOrder(made);
    for (const [i, s] of all.entries()) {
      const p = await page(`limit=50&cursor=${cur(s.name, s.id)}`);
      expect([s.name, p.items.map((x) => x.id)]).toEqual([
        s.name,
        all.slice(i + 1).map((x) => x.id),
      ]);
    }
  });

  it('the cursor a page hands out is the position of its last school', async () => {
    const all = expectedOrder(made);
    for (const limit of [1, 3, 8]) {
      const p = await page(`limit=${limit}`);
      expect(p.nextCursor).toBe(cur(all[limit - 1].name, all[limit - 1].id));
    }
  });

  it('ordinary names: lower-case first letters sit among their letter, not after Z', async () => {
    const names = (await page('limit=50')).items.map((s) => s.name);
    const at = (n: string) => names.indexOf(n);
    // by first letter, whatever the case of it
    expect(at('altSchool Africa')).toBeLessThan(
      at('Andela Learning Community'),
    );
    expect(at('Andela Learning Community')).toBeLessThan(
      at('CcHub Design Lab'),
    );
    expect(at('eHealth Africa Institute')).toBeLessThan(
      at('Ife Creative Arts'),
    );
    expect(at('Ife Creative Arts')).toBeLessThan(at('iLearn Academy'));
    expect(at('iLearn Academy')).toBeLessThan(at('Lagos Business School'));
    expect(at('Lagos Studios')).toBeLessThan(at('Pan Atlantic Hub'));
    expect(at('uLesson Studio')).toBeLessThan(at('Yaba College of Technology'));
    expect(at('Yaba College of Technology')).toBeLessThan(
      at('zeta Craft School'),
    );
    expect(at('zeta Craft School')).toBeLessThan(at('Zuri Training'));
    // digits first, then letters
    expect(at('100 Women Coders')).toBeLessThan(at('3MTT Nigeria'));
    expect(at('3MTT Nigeria')).toBeLessThan(at('altSchool Africa'));
    // names that differ only in case sit together, capitals first
    const twins = ['CASE TWIN', 'Case Twin', 'case twin'].map(at);
    expect(twins[1]).toBe(twins[0] + 1);
    expect(twins[2]).toBe(twins[1] + 1);
  });

  it('a name outside the plane sorts by code point, after a flag, on every database', async () => {
    const names = (await page('limit=50')).items.map((s) => s.name);
    // the two cases the first SCHOOLS-04 spec leaned on
    expect(names.indexOf(`${FLAG}${FLAG}${FLAG}`)).toBeLessThan(
      names.indexOf(`${FLAG}${FLAG}${LATER}`),
    );
    expect(names.indexOf(`${FLAG} Flag School`)).toBeLessThan(
      names.indexOf(`${LATER} Outside The Plane`),
    );
  });
});
