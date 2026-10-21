/** One unpaid start under a code: the phone and email it was made with. */
export interface HeldStart {
  phone: string;
  email: string;
}

/**
 * How many different people a set of unpaid starts is (SWEEP-JOIN D3, L1).
 * Two starts are the same person when they share a phone OR an email, and so
 * is anyone linked to them through a chain of such starts: a person who
 * corrects their phone and keeps the email, then changes the email and keeps
 * the corrected phone, is still one person. Each person holds one place.
 *
 * With `requester` (the start being decided, not yet made) the person that
 * start belongs to is left out of the count: it is about to be replaced by
 * that start, and a start that links two others joins them into that one
 * person.
 *
 * A pure function over distinct phone and email pairs; no database. Someone
 * who changes BOTH the phone and the email on every start is, by this rule,
 * many people: the per-address throttle is what bounds that.
 */
export function countPeople(
  starts: HeldStart[],
  requester?: HeldStart,
): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Compress the path so later finds are short.
    for (let cur = x; cur !== root;) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const join = (s: HeldStart) => {
    parent.set(find(`p:${s.phone}`), find(`e:${s.email}`));
  };
  for (const s of starts) join(s);
  if (requester) join(requester);
  const people = new Set(starts.map((s) => find(`p:${s.phone}`)));
  if (requester) people.delete(find(`p:${requester.phone}`));
  return people.size;
}
