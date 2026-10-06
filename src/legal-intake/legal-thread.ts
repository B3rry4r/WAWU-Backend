import type { PrismaService } from '../common/prisma/prisma.service';

/** One message as the app and the consultant's screen read it. */
export interface ChatMessageView {
  id: string;
  authorRole: 'client' | 'ai' | 'consultant';
  body: string;
  createdAt: Date;
}

export interface ThreadRow extends ChatMessageView {
  authorAdminId: string | null;
}

/**
 * One conversation, in order, across the moment an intake becomes a matter.
 *
 * The chat that writes the brief is stored against the intake
 * (`LegalIntakeMessage`); once the brief is sent, the matter's own messages
 * (`LegalChatMessage`) carry on. The person and the consultant read both as
 * one thread, so nothing is copied and nobody is asked to say it again.
 *
 * Give the intake id when you have it; the matter's id finds the intake that
 * became it (a matter that never came from an intake simply has no earlier
 * half).
 */
export async function loadThreadMessages(
  prisma: PrismaService,
  ref: { legalIntakeId?: string | null; legalRequestId?: string | null },
): Promise<ThreadRow[]> {
  const intakeWhere = ref.legalIntakeId
    ? { legalIntakeId: ref.legalIntakeId }
    : ref.legalRequestId
      ? { intake: { legalRequestId: ref.legalRequestId } }
      : null;

  const [before, after] = await Promise.all([
    intakeWhere
      ? prisma.legalIntakeMessage.findMany({
          where: intakeWhere,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
    ref.legalRequestId
      ? prisma.legalChatMessage.findMany({
          where: { legalRequestId: ref.legalRequestId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : Promise.resolve([]),
  ]);

  const rows: ThreadRow[] = [
    ...before.map((m) => ({
      id: m.id,
      authorRole: m.authorRole,
      authorAdminId: null,
      body: m.body,
      createdAt: m.createdAt,
    })),
    ...after.map((m) => ({
      id: m.id,
      authorRole: m.authorRole,
      authorAdminId: m.authorAdminId,
      body: m.body,
      createdAt: m.createdAt,
    })),
  ];
  // A stable sort: the earlier half stays ahead of the later one on a tie.
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * The first name of the consultant who joined, for "Adaora joined". Null when
 * no consultant has written, or the admin is gone.
 */
export async function consultantNameFor(
  prisma: PrismaService,
  messages: ThreadRow[],
): Promise<string | null> {
  const first = messages.find(
    (m) => m.authorRole === 'consultant' && m.authorAdminId,
  );
  if (!first?.authorAdminId) return null;
  const admin = await prisma.adminUser.findUnique({
    where: { id: first.authorAdminId },
    select: { name: true },
  });
  const name = admin?.name.trim().split(/\s+/)[0];
  return name ? name : null;
}
