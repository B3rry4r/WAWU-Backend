import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditSpendModule } from '../credit-spend.module';
import { CreditSpendService } from '../credit-spend.service';

/**
 * Contract tests for CreditSpend.
 *
 * registry.json declares an EMPTY `endpoints` array for this resource — it
 * is an internal, append-only ledger row written by the CommunityMessage
 * module (a separate wave-0 resource) as a side effect of
 * `POST /communities/:id/messages`, never its own routed HTTP surface.
 * There is therefore no controller/supertest layer here and no auth
 * guard to exercise a 401/403 case against: CreditSpendService.record()
 * IS the contract, called internally by an already-authenticated caller.
 * Per the task brief's per-endpoint checklist ("...where the endpoint
 * requires auth"), that clause does not apply to a resource with zero
 * endpoints — documented here rather than faked with an irrelevant test.
 *
 * What IS exercised, mirroring the checklist's intent at the service
 * boundary:
 *  - valid input -> contracted row shape (equivalent of "valid request in
 *    -> 2xx shape out")
 *  - invalid payload -> rejected (equivalent of the 400 case)
 *  - a payload referencing a community that doesn't exist -> rejected
 *    (this resource's actual analogue of an authorization-shaped failure:
 *    the one thing record() itself refuses is a dangling foreign key)
 *
 * Uses the seeded wawu_hub_test fixtures (prisma/seed.ts): the 3 mock WAWU
 * ID users and the seeded "WAWU Founders Circle" community
 * (id 20000000-0000-4000-8000-000000000001, host = Pro creator
 * 00000000-0000-4000-8000-000000000003).
 */
describe('CreditSpend (contract)', () => {
  let moduleRef: TestingModule;
  let service: CreditSpendService;
  let prisma: PrismaService;

  const USER_PLAIN = '00000000-0000-4000-8000-000000000001';
  const USER_CREATOR_BASIC = '00000000-0000-4000-8000-000000000002';
  const USER_CREATOR_PRO = '00000000-0000-4000-8000-000000000003'; // seeded community host
  const SEEDED_COMMUNITY_ID = '20000000-0000-4000-8000-000000000001';
  const NONEXISTENT_COMMUNITY_ID = '20000000-0000-4000-8000-00000000dead';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CreditSpendModule],
    }).compile();

    service = moduleRef.get(CreditSpendService);
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    // Keep the ledger table clean between tests without touching the
    // seeded Community/UserProfile fixtures other resources' tests rely on.
    await prisma.creditSpend.deleteMany({ where: { userWawuId: USER_PLAIN } });
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  describe('record() — valid input -> contracted shape', () => {
    it('creates a CreditSpend row matching the registry.json field contract', async () => {
      const result = await service.record({
        userWawuId: USER_PLAIN,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });

      expect(result).toMatchObject({
        userWawuId: USER_PLAIN,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
        creditsSpent: 1, // registry.json: "always 1" — never caller-suppliable
      });
      expect(typeof result.id).toBe('string');
      expect(result.spentAt).toBeInstanceOf(Date);

      const persisted = await prisma.creditSpend.findUnique({
        where: { id: result.id },
      });
      expect(persisted).not.toBeNull();
      expect(persisted?.creditsSpent).toBe(1);
    });

    it('rejects a caller-supplied creditsSpent outright — the DTO has no such field, and validation is whitelist+forbidNonWhitelisted (mirrors the global ValidationPipe convention), so a smuggled credit count fails closed rather than being silently stripped', async () => {
      await expect(
        service.record({
          userWawuId: USER_PLAIN,
          communityId: SEEDED_COMMUNITY_ID,
          creatorWawuId: USER_CREATOR_PRO,
          // @ts-expect-error — intentionally probing that an extraneous field
          // cannot smuggle a different credit count onto the ledger row.
          creditsSpent: 999,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('record() — invalid payload -> rejected (400 equivalent)', () => {
    it('rejects a missing userWawuId', async () => {
      await expect(
        service.record({
          userWawuId: '',
          communityId: SEEDED_COMMUNITY_ID,
          creatorWawuId: USER_CREATOR_PRO,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing communityId', async () => {
      await expect(
        service.record({
          userWawuId: USER_PLAIN,
          communityId: '',
          creatorWawuId: USER_CREATOR_PRO,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing creatorWawuId', async () => {
      await expect(
        service.record({
          userWawuId: USER_PLAIN,
          communityId: SEEDED_COMMUNITY_ID,
          creatorWawuId: '',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-string field smuggled in via an untyped caller', async () => {
      await expect(
        service.record({
          userWawuId: USER_PLAIN,
          communityId: SEEDED_COMMUNITY_ID,
          // @ts-expect-error — deliberately wrong type to prove validation runs
          creatorWawuId: 12345,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("record() — dangling reference -> rejected (this resource's auth-shaped failure)", () => {
    it('rejects a communityId that does not exist', async () => {
      await expect(
        service.record({
          userWawuId: USER_PLAIN,
          communityId: NONEXISTENT_COMMUNITY_ID,
          creatorWawuId: USER_CREATOR_PRO,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listForCreator()', () => {
    it('returns only the given creator (ledger rows), most recent first', async () => {
      await service.record({
        userWawuId: USER_PLAIN,
        communityId: SEEDED_COMMUNITY_ID,
        creatorWawuId: USER_CREATOR_PRO,
      });

      const rows = await service.listForCreator(USER_CREATOR_PRO);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.creatorWawuId === USER_CREATOR_PRO)).toBe(
        true,
      );

      const otherCreatorRows = await service.listForCreator(USER_CREATOR_BASIC);
      expect(
        otherCreatorRows.every((r) => r.creatorWawuId === USER_CREATOR_BASIC),
      ).toBe(true);
    });
  });
});
