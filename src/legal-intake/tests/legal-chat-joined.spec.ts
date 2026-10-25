import { LegalChatService } from '../legal-chat.service';

/**
 * R2-MONEY2 (CHECK-3 H-01): the first line a consultant writes in a matter's
 * conversation is "a consultant joined" and tells the client once; later
 * lines do not. No database: the thread and the lock are stood in.
 */
function make(alreadyWritten: boolean) {
  const request = { id: 'r-1', wawuUserId: 'u-1' };
  const tx = {
    legalChatMessage: {
      findFirst: jest.fn(() =>
        Promise.resolve(alreadyWritten ? { id: 'm-0' } : null),
      ),
      create: jest.fn(() => Promise.resolve({ id: 'm-1' })),
    },
  };
  const allowance = {
    writeAsConsultant: jest.fn(
      (_user: string, write: (t: unknown, at: Date) => Promise<unknown>) =>
        write(tx, new Date()),
    ),
  };
  const live = { publish: jest.fn(() => Promise.resolve()) };
  const notices = { consultantJoined: jest.fn(() => Promise.resolve()) };
  const prisma = {
    legalRequest: { findUnique: jest.fn(() => Promise.resolve(request)) },
  };
  const service = new LegalChatService(
    prisma as never,
    {} as never,
    allowance as never,
    0,
    live as never,
    {} as never,
    notices as never,
  );
  // The thread read is not what is under test.
  (service as unknown as { threadFor: () => Promise<unknown> }).threadFor =
    () => Promise.resolve({});
  return { service, notices, live };
}

describe('a consultant joining (R2-MONEY2)', () => {
  it('tells the client on the first line a consultant writes, once the line is saved', async () => {
    const { service, notices, live } = make(false);
    await service.sendAsConsultant('r-1', 'admin-1', 'Hello.');
    expect(live.publish).toHaveBeenCalledTimes(1);
    expect(notices.consultantJoined).toHaveBeenCalledWith('r-1');
  });

  it('does not tell again on a later line', async () => {
    const { service, notices } = make(true);
    await service.sendAsConsultant('r-1', 'admin-1', 'Hello again.');
    expect(notices.consultantJoined).not.toHaveBeenCalled();
  });
});
