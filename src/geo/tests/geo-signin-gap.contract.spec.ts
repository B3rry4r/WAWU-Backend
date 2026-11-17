// Run against a test database: always via `npm run test:contract`.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GeoModule } from '../geo.module';
import { ProfileLocationService } from '../profile-location.service';

/**
 * F1 (verifier, GEO-FILL): the sign-in recording writes only where there is
 * still no country. A choice that lands between its read and its write
 * survives.
 */
const A = 'b6000000-0000-4000-8000-000000000001'; // chose KE in the gap, row existed
const B = 'b6000000-0000-4000-8000-000000000002'; // chose KE in the gap, no row at the read
const C = 'b6000000-0000-4000-8000-000000000003'; // nothing in the gap

describe('Sign-in recording never replaces a chosen country (F1)', () => {
  let prisma: PrismaService;
  let places: ProfileLocationService;
  let close: () => Promise<void>;
  const EMPTY = {
    countryCode: null,
    regionCode: null,
    regionName: null,
    city: null,
    countrySource: null,
  };
  const sweep = () =>
    prisma.profileDetails.deleteMany({
      where: { wawuUserId: { in: [A, B, C] } },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        GeoModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    places = moduleRef.get(ProfileLocationService);
    close = () => moduleRef.close();
    await sweep();
  });
  afterAll(async () => {
    await sweep();
    await close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps a country chosen after the read (a row with no country at the read)', async () => {
    await prisma.profileDetails.create({ data: { wawuUserId: A } });
    // The read saw no country; then the person's own choice landed.
    jest.spyOn(places, 'stored').mockImplementationOnce(async () => {
      await prisma.profileDetails.update({
        where: { wawuUserId: A },
        data: { countryCode: 'KE', countrySource: 'profile' },
      });
      return EMPTY;
    });
    const wrote = await places.recordIfMissing(A, { countryCode: 'NG' });
    expect(wrote).toBe(false);
    expect(
      await prisma.profileDetails.findUnique({ where: { wawuUserId: A } }),
    ).toMatchObject({
      countryCode: 'KE',
      countrySource: 'profile',
    });
  });

  it('keeps a country chosen after the read (no row at the read)', async () => {
    jest.spyOn(places, 'stored').mockImplementationOnce(async () => {
      await prisma.profileDetails.create({
        data: { wawuUserId: B, countryCode: 'KE', countrySource: 'profile' },
      });
      return EMPTY;
    });
    await expect(
      places.recordIfMissing(B, { countryCode: 'NG' }),
    ).resolves.toBe(false);
    expect(
      await prisma.profileDetails.findUnique({ where: { wawuUserId: B } }),
    ).toMatchObject({
      countryCode: 'KE',
      countrySource: 'profile',
    });
  });

  it('still records when nothing intervened', async () => {
    await expect(
      places.recordIfMissing(C, { countryCode: 'NG' }),
    ).resolves.toBe(true);
    expect(
      await prisma.profileDetails.findUnique({ where: { wawuUserId: C } }),
    ).toMatchObject({
      countryCode: 'NG',
      countrySource: 'wawu_id',
    });
  });
});
