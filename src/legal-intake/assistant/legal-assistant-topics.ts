import { matterLabel, type LegalMatter } from '../legal-intake-questions';
import type { LegalAssistantTopic } from './legal-assistant.types';

/**
 * The problems the assistant offers as taps when it opens (S14).
 *
 * Served, not drawn into the app, so the wording can change without a
 * release and the app never maps a label to a matter itself. Each maps to one
 * of the fourteen intake matters, which is what decides the questions the
 * assistant may record answers to and the catalogue service the matter opens
 * as. "Something else" is `other`: the assistant then works out the matter
 * from what the client writes.
 */
const TOPICS: ReadonlyArray<{ label: string; matter: LegalMatter }> = [
  { label: 'A tenancy problem', matter: 'property' },
  { label: 'Register a business', matter: 'business_registration' },
  { label: 'Check a contract', matter: 'contract' },
  { label: 'Something else', matter: 'other' },
];

export const TOPIC_ID_PREFIX = 'topic:';

export const ASSISTANT_TOPICS: LegalAssistantTopic[] = TOPICS.map((t) => ({
  id: `${TOPIC_ID_PREFIX}${t.matter}`,
  label: t.label,
  matter: t.matter,
  matterLabel: matterLabel(t.matter),
}));

export function topicById(id: string): LegalAssistantTopic | undefined {
  return ASSISTANT_TOPICS.find((t) => t.id === id);
}
