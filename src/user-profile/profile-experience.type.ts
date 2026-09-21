/**
 * One role as the API returns it.
 *
 * `startedOn` and `endedOn` are months ("2023-03"), never full dates: see
 * profile-experience.dto.ts for why the wire format is narrower than the
 * column.
 *
 * `current` is DERIVED from `endedOn === null` on the way out. It is here
 * because every client wants it and none of them should each re-derive it,
 * and it is not a column for the reason the schema states: a stored `current`
 * beside a stored `endedOn` is two facts that can contradict each other.
 */
export interface ProfileExperienceView {
  id: string;
  title: string;
  company: string;
  location: string | null;
  /** "YYYY-MM". */
  startedOn: string;
  /** "YYYY-MM", or null when this is the role they hold now. */
  endedOn: string | null;
  current: boolean;
  description: string | null;
}
