import type { AiVoiceView } from '../ai-tools-view.type';

/** What the Receptionist routes answer (AITOOLS-06, R-109). Points are a count, never naira. */

export interface ReceptionistKnowledgeView {
  id: string;
  /** `text` (words typed), `url` (a web page) or `file` (a document). */
  kind: 'text' | 'url' | 'file';
  name: string;
  bytes: number;
  createdAt: string;
}

/** `GET /ai-tools/receptionist` and what every write answers. */
export interface ReceptionistView {
  /** True while the tool is listed (`ai.listed.receptionist`) and the Hub's agents are set up. False: the app draws nothing for it. */
  available: boolean;
  /** True once the person's Receptionist exists and can answer. */
  setUp: boolean;
  details: {
    businessName: string;
    offer: string;
    replyStyle: string;
    language: string;
    voiceId: string;
  } | null;
  knowledge: ReceptionistKnowledgeView[];
  limits: {
    docsMax: number;
    docMaxBytes: number;
    textMaxChars: number;
    messageMaxChars: number;
    voiceMaxMinutes: number;
    languages: { code: string; name: string }[];
  };
  /** The voices the Receptionist can speak in (the Hub's list). */
  voices: AiVoiceView[];
}

/** `DELETE /ai-tools/receptionist`: `pending` while the Hub is still removing the provider's copies (ask again). */
export interface ReceptionistRemovedView {
  receptionist: ReceptionistView;
  atProvider: 'gone' | 'pending';
}

/** `POST /ai-tools/receptionist/voice-sessions` and `.../{id}/end`. */
export interface VoiceSessionView {
  id: string;
  /** `working` until the talk is settled, then `done` (the real minutes kept) or `failed` (every point back). */
  state: 'working' | 'done' | 'failed';
  /** The link the phone talks on with the provider; used once. Null when the session is only being read again. */
  signedUrl: string | null;
  conversationId: string | null;
  /** The longest the session may last, in seconds. */
  maxSeconds: number;
  /** Points held while the session is open. */
  heldPoints: number;
  /** Points kept once it is done. */
  keptPoints: number;
  /** The real minutes kept, once done. */
  minutes: number | null;
}
