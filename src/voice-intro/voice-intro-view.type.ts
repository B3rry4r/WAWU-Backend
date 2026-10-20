/** What the voice routes answer (VOICE-01, VF3 to VF11). Points are a count, never naira. */

/** `GET /me/voice`: how the person's name is said. */
export interface MyVoiceView {
  /** The spelling the person saved for how their name is said; null until they save one. */
  namePhonetic: string | null;
  nameSavedAt: string | null;
  /** False until the Hub's voice tools are set up: the preview and the Voice Intro are then refused. */
  available: boolean;
}

/** `POST /me/voice/name-preview`: the name, said. */
export interface NamePreviewView {
  audioUrl: string;
  /** Always true: it is an AI voice (R-66). */
  aiVoice: true;
}

export interface VoiceRunView {
  id: string;
  state: 'working' | 'done' | 'failed';
  /** Points this run took; 0 when the tier's included first Voice Intro paid for it. */
  costPoints: number;
  /** True when the tier's included first Voice Intro paid for it. */
  included: boolean;
  /** Plain words when the run failed, else null. */
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /me/voice-intro` and what every Voice Intro write answers. */
export interface VoiceIntroView {
  /** The audio is an AI voice, always (R-66). */
  aiVoice: true;
  /** The script, as the person wrote it; null until they do. */
  text: string | null;
  /** The most characters the script can have, from the settings. */
  textMaxChars: number;
  consent: {
    /** The words the person agrees to. */
    line: string;
    given: boolean;
    at: string | null;
  };
  sample: { recorded: boolean; at: string | null };
  /** The Voice Intro audio, once one is made; null before. */
  audioUrl: string | null;
  /** What the next try costs. */
  next: {
    /** True when the tier still gives the first Voice Intro: it takes no points. */
    free: boolean;
    /** Points the next try takes (0 when free). */
    costPoints: number;
  };
  /** True when a try can start now: words, consent and sample are in, voices are on and no try is running. */
  canGenerate: boolean;
  /** The latest try; null if there has been none. */
  run: VoiceRunView | null;
}

/** `GET /users/:wawuId/voice-intro`: what anyone looking at a profile hears (R-66). */
export interface PublicVoiceIntroView {
  /** Null when the person has no Voice Intro. */
  voiceIntro: {
    url: string;
    /** Always true: the app shows the "AI voice" tag. */
    aiVoice: true;
  } | null;
}
