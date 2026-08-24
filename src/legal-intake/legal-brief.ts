import type { GeminiBrief } from '../common/ai/gemini-client.interface';
import {
  answerLabel,
  isQuestionVisible,
  matterLabel,
  questionsForMatter,
  type IntakeQuestion,
} from './legal-intake-questions';

/**
 * The consultant-facing brief.
 *
 * Two halves, and the split is the point. `facts` is what the client actually
 * said, rendered from their own answers — it cannot be wrong unless they were.
 * `analysis` is what Gemini made of it, and it is labelled as such wherever it
 * is shown. A lawyer reading this must always be able to tell which is which,
 * because one is evidence and the other is a prompt for their own judgement.
 */
export interface LegalBrief {
  matter: string;
  matterLabel: string;
  /** Question prompt and the client's answer, in the order they were asked. */
  facts: Array<{ question: string; answer: string }>;
  documentCount: number;
  /** Generated. Never presented as fact. */
  analysis: GeminiBrief;
  /** Which model produced `analysis`, and when. */
  generatedBy: string;
  generatedAt: string;
}

type Answers = Record<string, unknown>;

/** One answer as a person would read it. */
function renderAnswer(question: IntakeQuestion, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (Array.isArray(raw)) {
    const labels = raw
      .filter((v): v is string => typeof v === 'string')
      .map((v) => answerLabel(question, v));
    return labels.length > 0 ? labels.join(', ') : null;
  }
  if (typeof raw !== 'string') return null;
  return answerLabel(question, raw);
}

/**
 * The client's answers, as question-and-answer pairs.
 *
 * Skipped questions are dropped rather than rendered as "not answered". A
 * brief padded with fifteen blanks buries the six things the client did say,
 * and the consultant can see what was asked from the question set itself.
 */
export function renderFacts(
  matter: string,
  answers: Answers,
): Array<{ question: string; answer: string }> {
  const out: Array<{ question: string; answer: string }> = [];
  for (const question of questionsForMatter(matter)) {
    if (question.kind === 'documents') continue;
    if (!isQuestionVisible(question, answers)) continue;
    const answer = renderAnswer(question, answers[question.id]);
    if (answer === null) continue;
    out.push({ question: question.prompt, answer });
  }
  return out;
}

/**
 * What Gemini is told to do.
 *
 * Written to constrain rather than inspire. The failure that matters here is
 * a model inventing a fact about somebody's legal position and a busy lawyer
 * reading it as something the client said, so the instruction repeatedly
 * pushes back toward the transcript and explicitly forbids advice.
 */
export const BRIEF_INSTRUCTION = [
  'You prepare pre-consultation briefs for lawyers at WAWUAfrica, a Nigerian legal service.',
  'You will be given a client intake transcript: the questions they were asked and the answers they gave.',
  '',
  'Write for a qualified lawyer who has thirty seconds before the consultation starts.',
  '',
  'Rules, all of which matter:',
  '- Use ONLY what is in the transcript. Never state a fact the client did not give you.',
  '- Do not give legal advice and do not predict outcomes. You are briefing the lawyer, not advising the client.',
  '- Where the transcript is silent on something important, put it in questionsToClarify rather than guessing.',
  "- keyIssues are the legal questions this matter turns on, in the lawyer's vocabulary. Be specific to these facts, not generic.",
  '- risks are anything time-critical or costly that the client may not have noticed — a limitation period, a signed exclusivity, a deadline. Return an empty list if there are none. Do not manufacture one.',
  '- Nigerian law is the default unless the transcript says another jurisdiction.',
  '- summary is two or three plain sentences. No preamble, no restating these instructions.',
  '- Never address the client. Never use "you" to mean the client.',
].join('\n');

/** The transcript handed to the model. */
export function renderForModel(
  matter: string,
  facts: Array<{ question: string; answer: string }>,
  documentCount: number,
): string {
  const lines = [
    `Matter: ${matterLabel(matter)}`,
    '',
    'Client intake transcript:',
    ...facts.map((f) => `- ${f.question}\n  ${f.answer}`),
    '',
    documentCount > 0
      ? `The client attached ${documentCount} document(s). You cannot see them; note in questionsToClarify anything that depends on their contents.`
      : 'The client attached no documents.',
  ];
  return lines.join('\n');
}
