import { countPeople } from '../referral/referral-people';

/** SWEEP-JOIN round 2 (L1): who is one person among unpaid starts. */
describe('countPeople', () => {
  const s = (phone: string, email: string) => ({ phone, email });

  it('is 0 for no starts and 1 for one person starting again and again', () => {
    expect(countPeople([])).toBe(0);
    expect(countPeople([s('p1', 'e1')])).toBe(1);
    expect(countPeople([s('p1', 'e1'), s('p1', 'e1')])).toBe(1);
  });

  it('treats a shared phone, or a shared email, as the same person', () => {
    expect(countPeople([s('p1', 'e1'), s('p1', 'e2')])).toBe(1);
    expect(countPeople([s('p1', 'e1'), s('p2', 'e1')])).toBe(1);
  });

  it('follows a chain: a corrected phone, then a changed email, is still one person', () => {
    expect(countPeople([s('p1', 'e1'), s('p2', 'e1'), s('p2', 'e2')])).toBe(1);
    // The chain can be met in any order.
    expect(countPeople([s('p2', 'e2'), s('p1', 'e1'), s('p2', 'e1')])).toBe(1);
  });

  it('counts people who share nothing apart', () => {
    expect(countPeople([s('p1', 'e1'), s('p2', 'e2'), s('p3', 'e3')])).toBe(3);
    expect(countPeople([s('p1', 'e1'), s('p1', 'e2'), s('p3', 'e3')])).toBe(2);
  });

  it('leaves out the requester, and every start linked to them', () => {
    const starts = [s('p1', 'e1'), s('p2', 'e2'), s('p3', 'e3')];
    expect(countPeople(starts, s('p1', 'e9'))).toBe(2);
    // A requester who links two others joins them into the one person.
    expect(countPeople(starts, s('p1', 'e2'))).toBe(1);
    expect(countPeople(starts, s('p7', 'e7'))).toBe(3);
    expect(countPeople([], s('p7', 'e7'))).toBe(0);
  });
});
