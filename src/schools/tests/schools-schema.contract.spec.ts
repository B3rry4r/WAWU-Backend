import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * SCHOOLS-01: the schools data model on a real database.
 *
 * No route reads or writes these tables yet (SCHOOLS-02 writes them from the
 * dashboard, SCHOOLS-04 serves them to the app), so this spec talks to the
 * tables through the generated client, exactly as those services will. It owns
 * its rows (one school under a fixed UUID nothing else uses) and deletes them
 * in afterAll, so it leaves the test database as it found it.
 */
const SCHOOL_ID = '5c400000-0000-4000-8000-000000000001';

describe('Schools data model (SCHOOLS-01)', () => {
  const prisma = new PrismaService();

  async function cleanUp(): Promise<void> {
    await prisma.school.deleteMany({ where: { id: SCHOOL_ID } });
  }

  beforeAll(async () => {
    await prisma.$connect();
    await cleanUp();
  });

  afterAll(async () => {
    await cleanUp();
    await prisma.$disconnect();
  });

  it('stores a school with a course and a dated intake, and reads every field back', async () => {
    await prisma.school.create({
      data: {
        id: SCHOOL_ID,
        name: 'Schema Spec Academy',
        category: 'tech',
        location: 'Yaba, Lagos',
        foundedYear: 2016,
        expertise: ['Product design', 'Software'],
        about: 'A school this spec creates and deletes.',
        logo: 'https://storage.example/logo.png',
        applyUrl: 'https://school.example/apply',
        reportEmail: 'reports@school.example',
        courses: {
          create: {
            title: 'Product Design Bootcamp',
            weeks: 12,
            mode: 'hybrid',
            syllabus: ['Research', 'Wireframes', 'Prototypes'],
            outcomes: ['Certificate', 'Mentor', 'Portfolio'],
            priceKobo: 15_000_000,
            intakes: {
              create: {
                startDate: new Date('2026-11-03'),
                schedule: 'Weekend class',
                location: 'Yaba',
                capacity: 20,
              },
            },
          },
        },
      },
    });

    const school = await prisma.school.findUniqueOrThrow({
      where: { id: SCHOOL_ID },
      include: { courses: { include: { intakes: true } } },
    });
    expect(school).toMatchObject({
      name: 'Schema Spec Academy',
      category: 'tech',
      location: 'Yaba, Lagos',
      foundedYear: 2016,
      expertise: ['Product design', 'Software'],
      logo: 'https://storage.example/logo.png',
      applyUrl: 'https://school.example/apply',
      reportEmail: 'reports@school.example',
    });
    expect(school).not.toHaveProperty('rating');
    expect(school.courses).toHaveLength(1);
    const [course] = school.courses;
    expect(course).toMatchObject({
      title: 'Product Design Bootcamp',
      weeks: 12,
      mode: 'hybrid',
      syllabus: ['Research', 'Wireframes', 'Prototypes'],
      outcomes: ['Certificate', 'Mentor', 'Portfolio'],
      priceKobo: 15_000_000,
    });
    expect(course.intakes).toHaveLength(1);
    const [intake] = course.intakes;
    expect(intake.startDate.toISOString().slice(0, 10)).toBe('2026-11-03');
    expect(intake).toMatchObject({
      schedule: 'Weekend class',
      location: 'Yaba',
      capacity: 20,
      seatsTaken: 0,
    });
  });

  it('gives the last seat to exactly one of two racing claims', async () => {
    const course = await prisma.schoolCourse.findFirstOrThrow({
      where: { schoolId: SCHOOL_ID },
    });
    const intake = await prisma.courseIntake.create({
      data: {
        courseId: course.id,
        startDate: new Date('2027-01-12'),
        schedule: 'Weekday evenings',
        capacity: 1,
      },
    });

    // The claim SCHOOLS-07 makes: a conditional write, never read-then-write.
    const claim = () =>
      prisma.courseIntake.updateMany({
        where: { id: intake.id, seatsTaken: { lt: 1 } },
        data: { seatsTaken: { increment: 1 } },
      });
    const results = await Promise.all([claim(), claim()]);

    expect(results.map((r) => r.count).sort()).toEqual([0, 1]);
    const after = await prisma.courseIntake.findUniqueOrThrow({
      where: { id: intake.id },
    });
    expect(after.seatsTaken).toBe(1);
  });

  it('refuses an intake whose seats taken would pass its capacity', async () => {
    const intake = await prisma.courseIntake.findFirstOrThrow({
      where: { course: { schoolId: SCHOOL_ID }, capacity: 1 },
    });
    await expect(
      prisma.courseIntake.update({
        where: { id: intake.id },
        data: { seatsTaken: 2 },
      }),
    ).rejects.toThrow();
    const unchanged = await prisma.courseIntake.findUniqueOrThrow({
      where: { id: intake.id },
    });
    expect(unchanged.seatsTaken).toBe(1);
  });

  it('removes a school together with its courses and intakes', async () => {
    await prisma.school.delete({ where: { id: SCHOOL_ID } });
    expect(
      await prisma.schoolCourse.count({ where: { schoolId: SCHOOL_ID } }),
    ).toBe(0);
    expect(
      await prisma.courseIntake.count({
        where: { course: { schoolId: SCHOOL_ID } },
      }),
    ).toBe(0);
  });
});
