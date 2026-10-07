import {
  LEGAL_MATTERS,
  LEGAL_MATTER_VALUES,
  matterLabel,
  questionsForMatter,
  type IntakeQuestion,
} from '../legal-intake-questions';
import { cleanAiText } from '../ai-text';
import { ASSISTANT_LIMITS } from './legal-assistant-config';

/**
 * What the AI provider is told on a profiling turn, and how its answer is
 * read back (LEGAL-01).
 *
 * WHAT IS SENT, AND WHAT IS NOT. A turn sends the instruction below (fixed
 * text, the list of matters, the current matter's intake questions and option
 * values, and the brief and answers the earlier turns already took from the
 * client's own words) and the conversation itself: the client's messages and
 * the assistant's earlier replies. The lines the server writes (`scripted`:
 * the opener, which carries the client's first name, and the "sent" line) are
 * left out. Never sent: the client's name, email, phone, account or intake
 * id, documents, or anything from their profile or wallet. The `gender`
 * question is not offered to the model and an answer to it is never taken
 * from the model: a consultant asks it when it bears on the matter.
 *
 * WHAT IS TRUSTED. Nothing, as given. The reply and every label are cut to
 * size and lose any em-dash; a matter must be one of the fourteen; an answer
 * must be a question id of this matter with one of its own option values.
 * Whether the brief is ready is the model's view, but the server decides
 * whether it can be sent (`LegalAssistantService`).
 */

/** Questions the model may never answer, whatever the client wrote. */
const NOT_FOR_THE_MODEL = new Set(['gender']);

export interface AssistantFact {
  label: string;
  value: string;
}

export interface AssistantDraft {
  headline: string | null;
  facts: AssistantFact[];
  ready: boolean;
}

/** One profiling turn, as read from the model's answer. */
export interface AssistantTurn {
  reply: string;
  quickReplies: string[];
  matter: string | null;
  headline: string | null;
  facts: AssistantFact[];
  /** Raw: checked against the matter's questions by `validAnswers`. */
  answers: Record<string, unknown>;
  briefReady: boolean;
}

export interface HistoryMessage {
  authorRole: 'client' | 'assistant';
  scripted: boolean;
  body: string;
}

const INSTRUCTION = [
  'You are the WAWU Legal assistant in the Who Made This app. A client has come to you with a legal problem. Nothing has been paid and no consultant has read it yet.',
  '',
  'Your job: understand the problem well enough to write a short brief that a consultant reads before they reply. Ask the questions a consultant would need answered, one at a time, then show the brief.',
  '',
  'Rules, all of which matter:',
  '- You are NOT a lawyer and you do not give legal advice. If the client asks what the law says, what they should do or what will happen, say a consultant will answer that, then carry on with your questions.',
  '- Never mention a price, a fee, a timeline or an outcome.',
  '- One short question per message. Plain words, no legal jargon, no preamble. Never use an em-dash.',
  '- Never invent a fact. The brief holds only what the client said.',
  '- Never ask for or repeat an ID number, a bank detail, a password or a phone number.',
  '- Aim for three to six questions in all. Once you know what the problem is, where it is and the facts a consultant needs first, stop asking and set briefReady to true.',
  '- Nigerian law is the default unless the client says otherwise.',
  '',
  'Answer with ONE JSON object and nothing else (no code fence, no text around it), with exactly these keys:',
  '{',
  '  "reply": "your message to the client",',
  '  "quickReplies": ["up to 4 short answers the client can tap for your question; [] when the question needs their own words"],',
  '  "matter": "one matter value from the list below, or null while it is not clear",',
  '  "headline": "the problem in at most six words, for example \\"Tenancy · rent increase\\", or null",',
  '  "facts": [{ "label": "at most four words", "value": "what the client said, short" }],',
  '  "answers": { "question id": "option value, list of option values, or text" },',
  '  "briefReady": false',
  '}',
  '"facts" is the WHOLE brief so far every time, not only what is new: at most 8 rows, the client\'s own facts only, never the matter itself and never your own analysis.',
  '"answers" may use only the question ids and option values listed below, and only where the client\'s words clearly answer the question. Leave it {} otherwise.',
  'When briefReady is true, "reply" is one short line asking the client to check the brief, such as "Thanks. Here\'s what I\'ll pass on. Check it\'s right.", and "quickReplies" is [].',
].join('\n');

function describeQuestion(q: IntakeQuestion): string {
  const options = q.options?.map((o) => o.value).join(', ');
  const kind =
    q.kind === 'single'
      ? `one of: ${options}`
      : q.kind === 'multi'
        ? `a list of: ${options}`
        : q.kind === 'date'
          ? 'a date, YYYY-MM-DD'
          : 'text';
  return `- ${q.id}: ${q.prompt} (${kind})`;
}

/** The questions of a matter the model may record answers to. */
export function questionsForModel(matter: string): IntakeQuestion[] {
  return questionsForMatter(matter).filter(
    (q) => q.kind !== 'documents' && !NOT_FOR_THE_MODEL.has(q.id),
  );
}

export function buildInstruction(input: {
  matter: string;
  draft: AssistantDraft | null;
  answers: Record<string, unknown>;
}): string {
  const recorded = Object.fromEntries(
    Object.entries(input.answers).filter(([id]) => !NOT_FOR_THE_MODEL.has(id)),
  );
  return [
    INSTRUCTION,
    '',
    'Matters (value: label):',
    ...LEGAL_MATTERS.map((m) => `- ${m.value}: ${m.label}`),
    '',
    `The matter so far: ${input.matter} (${matterLabel(input.matter)}).`,
    '',
    'Intake questions for this matter (id: question (answer)):',
    ...questionsForModel(input.matter).map(describeQuestion),
    '',
    `The brief so far: ${JSON.stringify(input.draft?.facts ?? [])}`,
    `The headline so far: ${JSON.stringify(input.draft?.headline ?? null)}`,
    `Answers recorded so far: ${JSON.stringify(recorded)}`,
  ].join('\n');
}

/**
 * The conversation as the model reads it: scripted lines out, oldest first,
 * at most `limit` messages, starting with the client and alternating (two
 * client messages in a row, when a reply failed in between, are joined).
 */
export function buildHistory(
  messages: HistoryMessage[],
  limit: number,
): Array<{ role: 'user' | 'model'; text: string }> {
  const spoken = messages.filter((m) => !m.scripted).slice(-limit);
  const out: Array<{ role: 'user' | 'model'; text: string }> = [];
  for (const m of spoken) {
    const role = m.authorRole === 'client' ? 'user' : 'model';
    if (out.length === 0 && role === 'model') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n\n${m.body}`;
    else out.push({ role, text: m.body });
  }
  return out;
}

export { withoutEmDash } from '../ai-text';

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = cleanAiText(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The reply keeps its paragraphs; only runs of spaces are folded. */
function cleanReply(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = cleanAiText(value)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  const max = ASSISTANT_LIMITS.replyChars;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Reads the model's answer. Throws when there is no usable JSON object or no
 * reply in it: the caller treats that exactly like the provider failing.
 */
export function parseTurn(raw: string): AssistantTurn {
  const unfenced = raw.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('The assistant answer held no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new Error('The assistant answer was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The assistant answer was not an object');
  }
  const o = parsed as Record<string, unknown>;

  const reply = cleanReply(o.reply);
  if (!reply) throw new Error('The assistant answer had no reply');

  const quickReplies: string[] = [];
  if (Array.isArray(o.quickReplies)) {
    for (const q of o.quickReplies) {
      const label = cleanText(q, ASSISTANT_LIMITS.quickReplyChars);
      if (label && !quickReplies.includes(label)) quickReplies.push(label);
      if (quickReplies.length === ASSISTANT_LIMITS.quickReplies) break;
    }
  }

  const facts: AssistantFact[] = [];
  if (Array.isArray(o.facts)) {
    for (const f of o.facts) {
      if (!f || typeof f !== 'object') continue;
      const label = cleanText(
        (f as Record<string, unknown>).label,
        ASSISTANT_LIMITS.briefLabelChars,
      );
      const value = cleanText(
        (f as Record<string, unknown>).value,
        ASSISTANT_LIMITS.briefValueChars,
      );
      if (!label || !value) continue;
      if (label.toLowerCase() === 'matter') continue;
      facts.push({ label, value });
      if (facts.length === ASSISTANT_LIMITS.briefRows) break;
    }
  }

  const matter =
    typeof o.matter === 'string' &&
    (LEGAL_MATTER_VALUES as string[]).includes(o.matter)
      ? o.matter
      : null;

  const answers =
    o.answers && typeof o.answers === 'object' && !Array.isArray(o.answers)
      ? (o.answers as Record<string, unknown>)
      : {};

  return {
    reply,
    quickReplies,
    matter,
    headline: cleanText(o.headline, ASSISTANT_LIMITS.headlineChars),
    facts,
    answers,
    briefReady: o.briefReady === true,
  };
}

/**
 * The answers the model gave that this matter's questions accept: known ids
 * only, option values only, text cut to size, never `gender` or documents.
 */
export function validAnswers(
  matter: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const questions = new Map(questionsForModel(matter).map((q) => [q.id, q]));
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(raw)) {
    const q = questions.get(id);
    if (!q) continue;
    const allowed = new Set(q.options?.map((o) => o.value) ?? []);
    if (q.kind === 'single') {
      if (typeof value === 'string' && allowed.has(value)) out[id] = value;
    } else if (q.kind === 'multi') {
      const list = (Array.isArray(value) ? value : [value]).filter(
        (v): v is string => typeof v === 'string' && allowed.has(v),
      );
      if (list.length > 0) out[id] = [...new Set(list)];
    } else if (q.kind === 'date') {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        out[id] = value;
      }
    } else if (q.kind === 'text') {
      const text = cleanText(value, ASSISTANT_LIMITS.textAnswerChars);
      if (text) out[id] = text;
    }
  }
  return out;
}
