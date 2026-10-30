/** What the AI tools routes answer (AITOOLS-01, AITOOLS-02, PT1 and PT2). Points are a count, never naira. */

import type { PointsQuoteView } from '../points/spend/points-spend-view.type';
import type { AiToolId, AiToolInputKind, AiToolUnit } from './tools/ai-tool';

export interface AiVoiceView {
  id: string;
  name: string;
  description: string;
  /** A link to a short sample of the voice, for the play button on its row (AITOOLS-07); absent when the Hub has none for it. */
  sampleUrl?: string;
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
  /** What `costPointsPerUnit` is counted per: a `minute` of speech, one `use` (Sound effect), one `track` (Music track) or one `message` (Receptionist). */
  unit: AiToolUnit;
  /** Points for one unit, from the settings. */
  costPointsPerUnit: number;
  /** False until the voice provider is set up on the Hub: listed, but a job is refused. */
  enabled: boolean;
  /** What a job takes in: the app builds the tool's screen from this. */
  input: {
    /** The kind of input the job route takes: `text` (the words to speak, and a `voiceId`), `prompt` (a description in words) or `file` (a recording or video the person uploads first, AITOOLS-04). */
    kind: AiToolInputKind;
    /** `text` and `prompt` tools: the longest text or description one job takes (a setting). 0 for a `file` tool, which takes no text. */
    maxCharacters: number;
    /**
     * Characters that make one unit (a setting): `units` of a job is its
     * characters over this, rounded up, at least 1. For a `prompt` tool, one
     * use or track covers a description of any allowed length, so this equals
     * `maxCharacters`. 0 for a `file` tool, which is priced by the minute of
     * the file the Hub measures.
     */
    charactersPerUnit: number;
    /** `prompt` tools: the optional length a person may ask for, in seconds. The price is the same whatever the length. */
    length?: AiToolLengthView;
    /** `prompt` tools: true when the job takes an `instrumental` switch (a track without singing). */
    instrumental?: boolean;
    /** `file` tools: what the person may send, and the limits that stop a job. */
    file?: AiToolFileView;
    /** `image` and `video` tools (AITOOLS-09, AITOOLS-10): the shapes, lengths, photo and voice the screen draws. */
    options?: AiToolOptionsView;
    /** `dialogue` (AITOOLS-11): a scene of lines, each with a voice from `voices`; at most `maxVoices` different ones, `maxCharacters` characters in all. */
    dialogue?: { maxVoices: number };
    /** `podcast` (AITOOLS-13): one host or two, a length (each its own action and price) and a language, from the lists here. */
    podcast?: AiToolPodcastView;
  };
  voices: AiVoiceView[];
}

/** What the Podcast maker takes (AITOOLS-13): every value is the Hub's own, from the settings and the plan. */
export interface AiToolPodcastView {
  /** `conversation` (two voices talk it over) and `bulletin` (one host reads it). */
  modes: ('conversation' | 'bulletin')[];
  /** The most voices a podcast uses (a conversation's host and guest). */
  maxVoices: number;
  /** The lengths on offer; each has its own plan action (`POST /points/quote` takes it) and price in points. */
  durations: {
    id: 'short' | 'standard' | 'long';
    action: string;
    costPoints: number;
  }[];
  /** The longest web link, in characters (`https` only). */
  maxLinkCharacters: number;
  languages: { code: string; name: string }[];
}

/**
 * What a Studio picture or video tool takes beyond its description (AITOOLS-09, AITOOLS-10, R-109): every value is the
 * Hub's own, from the tool and its settings, so the app draws nothing it invented.
 */
export interface AiToolOptionsView {
  /** The shapes to pick from, as aspect ratios (`1:1`, `16:9`); empty when the result follows the photo's own shape (Talking photo). */
  shapes: string[];
  /** A video's lengths in seconds to pick from; absent for a picture. */
  lengths?: number[];
  /** The person's photo: `optional` or `required`; absent when the tool takes none. How to send it: through `POST /uploads/presign` with this folder, then `POST /uploads/confirm`. */
  photo?: {
    use: 'optional' | 'required';
    folder: string;
    accepts: string[];
    maxBytes: number;
  };
  /** Talking photo: the voice. A recording sent to `audioFolder` (then `audioKey`), or one of the person's finished voice results (`sourceJobId`). */
  speech?: {
    audioFolder: string;
    accepts: string[];
    maxSeconds: number;
    fromJob: boolean;
  };
}

/**
 * What a `file` tool takes (AITOOLS-04). The person uploads the file first
 * (`POST /uploads/presign` with the folder for its kind, a PUT to the link,
 * then `POST /uploads/confirm`) and names it by its `key`.
 */
export interface AiToolFileView {
  /** The folder for a recording and the folder for a video. */
  folders: { audio: string; video: string };
  /** The content types each folder takes. */
  accepts: { audio: string[]; video: string[] };
  /** The largest file, in bytes (a setting). */
  maxBytes: number;
  /** The longest file one job takes, in minutes (a setting). The Hub reads the real length itself. */
  maxMinutes: number;
  /** True when the job takes a `languageCode`. */
  languageCode: boolean;
  /** AITOOLS-11 and -12: the one kind of file the tool takes (`audio` or `video`); absent when it takes both. */
  only?: 'audio' | 'video';
  /** AITOOLS-11 and -12: the longest recording, video or song in seconds, when the tool bounds it (a setting). */
  maxSeconds?: number;
  /** AITOOLS-11 Voice changer: the job takes a `voiceId` from `voices` (`own` for the saved voice). */
  voice?: true;
  /** AITOOLS-11 Clone your own voice: the job takes a `name` and the person's agreement (see `GET /ai-tools/my-voice`). */
  clone?: true;
  /** AITOOLS-12 Music for a video: the job may carry a mood in words of up to this many characters. */
  description?: { maxCharacters: number };
  /** AITOOLS-12 Split a song: the numbers of parts to pick from. */
  parts?: number[];
  /** Dubbing only (AITOOLS-05): the languages the file can be heard in. The job takes `targetLanguage` from this list and may take `sourceLanguage` from it. One language a job. */
  dubbing?: AiToolDubbingView;
}

/** What Dubbing takes beyond the file (AITOOLS-05): the languages on offer, from the settings. */
export interface AiToolDubbingView {
  languages: { code: string; name: string }[];
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

/** One thing a done job made: audio to play, a picture or a video to show (`url`), or words (`text`). */
export interface AiJobOutputView {
  kind: 'audio' | 'text' | 'subtitles' | 'image' | 'video';
  /** A link the app plays, shows or downloads, for `audio`, `image` and `video` (and a subtitles file once a tool makes one). */
  url?: string;
  /** The words themselves, for `text` and `subtitles` kept inline. */
  text?: string;
  /** AITOOLS-08: the file's type, for an output that is a file. */
  contentType?: string;
  /** AITOOLS-08: the file's size in bytes. */
  bytes?: number;
  /** AITOOLS-08: a plain label ("Image", "Dubbed audio"); never a provider or model name. */
  name?: string;
  /** AITOOLS-08: the same file with an attachment file name such as `studio-image-30-oct-2026.png`. */
  downloadUrl?: string;
  /**
   * AITOOLS-08: the Create format that takes this file (`audio`, `video` or `image`, from `GET /uploads/formats`), or
   * null for a type no format takes (a FLAC dub, an AAC clip): then `POST /ai-tools/jobs/{id}/piece` refuses it.
   */
  pieceFormat?: 'audio' | 'video' | 'image' | null;
}

/** `POST /ai-tools/{tool}/jobs`, `GET /ai-tools/jobs/{id}` and each item of `GET /ai-tools/jobs`. */
export interface AiJobView {
  id: string;
  tool: AiToolId;
  state: AiJobStateView;
  /** The voice of a text job; empty for a `prompt` tool and a `file` tool, which have no voice. */
  voiceId: string;
  /** Dubbing (AITOOLS-05): the language the file is heard in; null for every other tool. */
  targetLanguage: string | null;
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
  /** True once the person has saved the result to their library (AITOOLS-07). */
  saved: boolean;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /ai-tools/own-voice` and what each own-voice write answers (AITOOLS-07, "Your voice" on PT2). */
export interface OwnVoiceView {
  /** False until the Hub's voice tools are set up. */
  available: boolean;
  /** True once the person has recorded their Voice Intro: their own recording is what their voice is made from. */
  hasRecording: boolean;
  consent: {
    /** The words the person agrees to, with their own name. Stored exactly, with the time; any other words are refused. */
    line: string;
    given: boolean;
    at: string | null;
  };
  /** True when "Your voice" can be picked now: the tools are on, the recording is there and the person agreed. */
  ready: boolean;
}

/** `DELETE /ai-tools/own-voice`: the agreement is taken back and the Hub asks the provider to drop every copy of the person's voice it still holds. */
export interface OwnVoiceRemovedView {
  own: OwnVoiceView;
  /** `gone`: the provider holds no copy of the person's voice. `pending`: a copy is still being removed (the Hub keeps trying). */
  atProvider: 'gone' | 'pending';
}

/** `GET /ai-tools/jobs`: the caller's own jobs, newest first, in cursor pages (CONVENTIONS section 6). */
export interface AiJobPage {
  items: AiJobView[];
  /** Send it back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/**
 * `POST /ai-tools/{captions|clean-audio}/quote` (AITOOLS-04): the points quote
 * (the same shape as `POST /points/quote`, with its `quoteToken`) for the
 * person's own file, priced by the length the Hub read from the file itself,
 * plus that length.
 */
export interface AiFileQuoteView extends PointsQuoteView {
  file: {
    /** The length the Hub read, in whole seconds (rounded up). */
    seconds: number;
    /** The minutes the job is priced in: rounded up, at least 1. */
    minutes: number;
  };
}

/**
 * `POST /ai-tools/talking-photo/quote` (AITOOLS-10): the points quote (the same shape as `POST /points/quote`, with its
 * `quoteToken`) for the voice the person chose, priced by the length the Hub read from the voice itself, plus that length.
 */
export interface AiSpeechQuoteView extends PointsQuoteView {
  speech: {
    /** The length the Hub read, in whole seconds (rounded up). It is also the number of units priced. */
    seconds: number;
  };
}

/**
 * `POST /ai-tools/jobs/{id}/piece` (AITOOLS-08, R-109): what Create's draft holds, so the app can open Create on the
 * step after the upload with the format chosen and the file already there. The Hub has copied the result into the
 * person's own content folder as an upload counted like any (R-7); nothing is published.
 */
export interface AiPieceView {
  /** The Create format that takes the file. */
  format: 'audio' | 'video' | 'image';
  /** The upload, as `POST /uploads/presign` would have answered, and as `POST /content` takes it (`fullAsset`). */
  full: {
    key: string;
    fileUrl: string;
    contentType: string;
    bytes: number;
    name: string;
  };
  /** A title to prefill, such as "Image, 30 Oct 2026". */
  suggestedTitle: string;
}

/** `GET /ai-tools/my-voice` (AITOOLS-11, "Clone your own voice"): whether the person keeps a clone of their voice, and what making one takes. */
export interface SavedVoiceView {
  /** True while the tool is listed and the Hub's voice tools are set up. False: the app draws nothing for it. */
  available: boolean;
  /** `none`: no clone. `making`: a job is making one. `ready`: kept, and "Your voice" is a choice in the voice tools. */
  state: 'none' | 'making' | 'ready';
  /** The name the person gave it; null when there is no clone. */
  name: string | null;
  createdAt: string | null;
  /** The words the person agrees to, with their own name. `POST /ai-tools/my-voice` takes them back unchanged as `consentLine`. */
  consent: { line: string };
  /** How to send the recording (through `POST /uploads/presign` with this folder, then `POST /uploads/confirm`) and what it must be. */
  recording: {
    folder: string;
    accepts: string[];
    minSeconds: number;
    maxSeconds: number;
    maxBytes: number;
  };
}

/** `DELETE /ai-tools/my-voice`: the clone has left every list; `pending` while the Hub is still removing the provider's copy. */
export interface SavedVoiceRemovedView {
  myVoice: SavedVoiceView;
  atProvider: 'gone' | 'pending';
}
