/** What the AI tools routes answer (AITOOLS-01, AITOOLS-02, PT1 and PT2). Points are a count, never naira. */

import type { AiToolId, AiToolInputKind, AiToolUnit } from './tools/ai-tool';

export interface AiVoiceView {
  id: string;
  name: string;
  description: string;
}

/** `GET /ai-tools`: one tool the Hub can run. The app draws only the tools listed here. */
export interface AiToolView {
  /** The tool's id in the routes (`POST /ai-tools/{id}/jobs`). */
  id: AiToolId;
  /** The plan's action id: what `POST /points/quote` takes as `action`. */
  action: string;
  name: string;
  /** One line under the name. */
  description: string;
  /** What `costPointsPerUnit` is counted per: a `minute` of speech, one `use` (Sound effect) or one `track` (Music track). */
  unit: AiToolUnit;
  /** Points for one unit, from the settings. */
  costPointsPerUnit: number;
  /** False until the voice provider is set up on the Hub: listed, but a job is refused. */
  enabled: boolean;
  /** What a job takes in: the app builds the tool's screen from this. */
  input: {
    /** The kind of input the job route takes: `text` (the words to speak, and a `voiceId`) or `prompt` (a description in words). */
    kind: AiToolInputKind;
    /** The longest text or description one job takes (a setting). */
    maxCharacters: number;
    /**
     * Characters that make one unit (a setting): `units` of a job is its
     * characters over this, rounded up, at least 1. For a `prompt` tool, one
     * use or track covers a description of any allowed length, so this equals
     * `maxCharacters`.
     */
    charactersPerUnit: number;
    /** `prompt` tools: the optional length a person may ask for, in seconds. The price is the same whatever the length. */
    length?: AiToolLengthView;
    /** `prompt` tools: true when the job takes an `instrumental` switch (a track without singing). */
    instrumental?: boolean;
  };
  voices: AiVoiceView[];
}

/** The optional length of a `prompt` tool's audio (`input.length`). */
export interface AiToolLengthView {
  /** The name of the field in the job route's body (`durationSeconds` or `lengthSeconds`). */
  field: string;
  /** The shortest the tool makes, in seconds. */
  min: number;
  /** The longest it makes, in seconds (a setting). */
  max: number;
  /** True when the length must be a whole number of seconds. */
  whole: boolean;
}

/** The caps that stop a job (the same figures `GET /plans` serves as `caps`). */
export interface AiToolCapsView {
  dailyPoints: number;
  maxCharactersPerJob: number;
  maxAudioMinutesPerJob: number;
}

export interface AiToolsView {
  tools: AiToolView[];
  caps: AiToolCapsView;
}

export type AiJobStateView = 'working' | 'done' | 'failed';

/** One thing a done job made: audio to play (`url`), or words (`text`). */
export interface AiJobOutputView {
  kind: 'audio' | 'text' | 'subtitles';
  /** A link the app plays or downloads, for `audio` (and a subtitles file once a tool makes one). */
  url?: string;
  /** The words themselves, for `text` and `subtitles` kept inline. */
  text?: string;
}

/** `POST /ai-tools/{tool}/jobs`, `GET /ai-tools/jobs/{id}` and each item of `GET /ai-tools/jobs`. */
export interface AiJobView {
  id: string;
  tool: AiToolId;
  state: AiJobStateView;
  /** The voice of a text job; empty for a `prompt` tool, which has no voice. */
  voiceId: string;
  characters: number;
  /** What the job was priced in: minutes of speech, or 1 for a use or a track. */
  units: number;
  /** What the job costs: held while working, kept when done, given back when failed. */
  costPoints: number;
  /** The audio to play, once the job is done. The same link as the `audio` output. */
  audioUrl: string | null;
  /** What the job made, once done; empty while working or when failed. */
  outputs: AiJobOutputView[];
  /** A failed job's words ("No points were taken"); null otherwise. */
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /ai-tools/jobs`: the caller's own jobs, newest first, in cursor pages (CONVENTIONS section 6). */
export interface AiJobPage {
  items: AiJobView[];
  /** Send it back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}
