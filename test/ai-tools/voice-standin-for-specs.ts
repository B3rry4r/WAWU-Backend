import type { Server } from 'http';

/** Starts the voice stand-in (scripts/dev/voice-standin.cjs) on a free port of 127.0.0.1 for a spec. */
export interface StandinHandle {
  server: Server;
  port: number;
  state: {
    calls: number;
    ok: number;
    failed: number;
    active: number;
    maxActive: number;
    /** The provider voice of each speech call, in order (a made voice reads `clone-N`). */
    voices: string[];
    /** The `model_id` of each speech call, in order (null when none was sent). */
    models: (string | null)[];
    lastModel: string | null;
    cloned: number;
    deleted: number;
    /** The ids of the voices made for a person's own sample, in order. */
    clones: string[];
    /** Deletes of a voice refused on purpose (a sample with `[[remove-fail]]`). */
    removeRefused: number;
    /** Reads of the provider's voice list. */
    voiceListReads: number;
    /** Each Sound effect call: the `duration_seconds` asked (null when none). */
    sfx: (number | null)[];
    /** Each Music call: the `music_length_ms` asked (null when none) and whether it was instrumental. */
    music: { lengthMs: number | null; instrumental: boolean }[];
    /** Each speech to text call (AITOOLS-04): the model, the language asked, the timestamps asked, the file's bytes and type. */
    transcribe: {
      model: string;
      languageCode: string | null;
      granularity: string | null;
      bytes: number;
      fileType: string | null;
    }[];
    /** Each audio isolation call: the file's bytes and type. */
    isolate: { bytes: number; fileType: string | null }[];
    deletedTranscripts: string[];
    deletedIsolations: string[];
    /** Every delete try on a provider copy and the status it got (404 while the copy is not stored yet). */
    deleteTries: {
      kind: 'transcript' | 'isolation' | 'dub';
      id: string;
      status: number;
      /** True when the provider answered 2xx and left the copy there (`[[ack-then-appear:MS]]`). */
      kept?: boolean;
    }[];
    /** Every read of a transcript copy by id and the status it got (round 3). */
    reads: {
      kind: 'transcript' | 'dub';
      id: string;
      status: number;
      hidden?: boolean;
    }[];
    /** Each Dubbing start (AITOOLS-05): the languages, the model and the file's bytes and type. */
    dubs: {
      target: string;
      source: string | null;
      model: string | null;
      bytes: number;
      fileType: string | null;
    }[];
    /** Each read of a dub's language target and the provider status it answered. */
    dubReads: {
      project: string;
      language: string;
      status: number;
      dub?: string;
    }[];
    /** Each fetch of a dub's signed link, and whether it carried the provider's key. */
    dubDownloads: {
      project: string;
      kind: string;
      status: number;
      leaked: boolean;
    }[];
    dubKeyLeaks: number;
    deletedDubs: string[];
    /** Each asset upload (AITOOLS-09, AITOOLS-10): the id, bytes, type and plain name; never the file. */
    assets: { id: string; bytes: number; type: string | null; name: string }[];
    deletedAssets: string[];
    /** Each picture start: the model, shape, size, the assets named and the description's length. */
    images: {
      model: string;
      shape: string | null;
      resolution: string | null;
      assetIds: string[];
      promptChars: number;
    }[];
    /** Each video start: a clip or a talking photo, with what it asked for and the assets named. */
    videos: {
      kind: 'clip' | 'talking';
      model: string;
      shape?: string | null;
      seconds?: number;
      resolution: string | null;
      withSound?: boolean | null;
      assetIds: string[];
      promptChars?: number;
    }[];
    genReads: {
      id: string;
      status: number;
      answered?: string;
      reason?: string;
    }[];
    genDownloads: { id: string; status: number; leaked: boolean }[];
    genKeyLeaks: number;
    /** Each Voice changer call (AITOOLS-11): the voice, the model, the file's bytes and type, and the noise switch sent. */
    voiceChanges: {
      voice: string;
      model: string | null;
      bytes: number;
      fileType: string | null;
      removeNoise: string | null;
    }[];
    /** Each Dialogue call: the model, the number of lines, the different voices and the characters; never the words. */
    dialogues: {
      model: string | null;
      lines: number;
      voices: string[];
      chars: number;
    }[];
    /** The name each voice add asked for. */
    cloneNames: string[];
    /** Each Music for a video call (AITOOLS-12): the file's bytes and type, the description's length and the model. */
    videoMusic: {
      bytes: number;
      fileType: string | null;
      descriptionChars: number;
      model: string | null;
    }[];
    /** Each Split a song call: the variation asked, the file's bytes and type. */
    stems: { variation: string; bytes: number; fileType: string | null }[];
    /** Each speech call's text length and the length of the words said to come before and after it (AITOOLS-13); null when none was sent. */
    speechContext: {
      chars: number;
      previous: number | null;
      next: number | null;
    }[];
    /** Each podcast start (AITOOLS-13); never the words. */
    podcasts: {
      id: string;
      mode: string;
      source: 'text' | 'url';
      chars: number;
      urlChars: number;
      host: string;
      guest: string | null;
      model: string | null;
      duration: string | null;
      language: string | null;
      quality: string | null;
    }[];
    podcastReads: { id: string; status: number }[];
    deletedPodcasts: string[];
    /** Each agent made (AITOOLS-06): its settings, never the instructions' words. */
    agents: {
      id: string;
      name: string;
      llm: string | null;
      language: string | null;
      firstMessage: string;
      voice: string | null;
      knowledge: string[];
      textOnlyOverride: boolean;
      promptChars: number;
      promptHasGuardrail: boolean;
      /** REC-PRIVACY: `platform_settings.privacy` as sent (null when none was). */
      privacy: Record<string, unknown> | null;
    }[];
    agentPatches: {
      id: string;
      knowledge: string[];
      language: string | null;
      /** REC-PRIVACY: `platform_settings.privacy` as sent (null when none was). */
      privacy?: Record<string, unknown> | null;
    }[];
    deletedAgents: string[];
    knowledge: {
      kind: string;
      name: string;
      bytes: number;
      fileType?: string | null;
    }[];
    deletedKnowledge: string[];
    signedUrls: number;
    /** Each text chat over the agent socket: whether it was text-only, whether earlier messages came, the length, whether the key was sent. */
    chats: {
      agent: string | null;
      textOnly: boolean;
      earlier: boolean;
      chars: number;
      keyLeak: boolean;
      pongs: number;
    }[];
    deletedConversations: string[];
    /** REC-PRIVACY: how many of the next conversation deletes the provider refuses with a 500. */
    conversationDeleteRefusals: number;
    /** REC-DELETE: the ids of conversations whose delete was answered 204 and ignored, as the real provider does for one not yet finished. */
    ignoredConversationDeletes: string[];
    /** REC-DELETE: what a text chat's conversation reads once its chat ends ('done' by default; 'processing' keeps it open until `setConversation` finishes it). */
    chatConversationStatus: string;
    /** REC-DELETE: whether deleting an agent takes its conversations with it (the real provider does). Off by default. */
    agentDeleteTakesConversations: boolean;
    /** REC-DELETE round 1: whether deleting an agent leaves its conversations listed but 404 by id (the real provider did, for one still being finished). Off by default. */
    agentDeleteOrphansConversations: boolean;
    /** REC-DELETE round 1: how long a conversation's DELETE takes to answer, in milliseconds (the real one took 7 to 8 seconds). */
    conversationDeleteDelayMs: number;
    /** REC-DELETE round 1: how many times the list of conversations was read. */
    conversationListReads: number;
  };
  /** Podcast projects, agents, documents and conversations the provider still holds (AITOOLS-13, AITOOLS-06). */
  openPodcasts: () => number;
  openAgents: () => number;
  openKnowledge: () => number;
  openConversations: () => number;
  /** What an agent holds now, as last sent. */
  agent: (
    id: string,
  ) => { knowledge: string[]; prompt: string; language: string | null } | null;
  /**
   * Sets how a conversation stands: its status and its length in seconds. `hidden: true` makes it read 404 while it exists
   * (the provider has not stored it yet); finishing it (`done` or `failed`) shows it again unless `hidden` is given.
   */
  setConversation: (
    id: string,
    patch: {
      status?: string;
      seconds?: number | null;
      hidden?: boolean;
      /** Not in the provider's list (not stored yet, or gone). */
      unlisted?: boolean;
    },
  ) => void;
  conversationIds: () => string[];
  /** Transcripts and cleaned recordings the provider still holds. */
  openTranscripts: () => number;
  openIsolations: () => number;
  /** Dub projects the provider still holds (AITOOLS-05). */
  openDubs: () => number;
  /** Assets (a person's photo or voice) the provider still holds (AITOOLS-09, AITOOLS-10). */
  openAssets: () => number;
  /** Voices the stand-in made for a person's own sample and has not yet had removed. */
  openClones: () => number;
  /** Lets the voices a `[[remove-fail]]` sample made be deleted from now on. */
  releaseStubborn: () => void;
}

type StandinModule = {
  startVoiceStandin: (o: {
    port: number;
    key: string;
    dubDelayMs?: number;
    genDelayMs?: number;
  }) => Promise<StandinHandle>;
};

export function startStandin(
  key: string,
  opts: { dubDelayMs?: number; genDelayMs?: number } = {},
): Promise<StandinHandle> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const mod = require('../../scripts/dev/voice-standin.cjs') as StandinModule;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return mod.startVoiceStandin({
    port: Number(process.env.VOICE_STANDIN_PORT ?? 0),
    key,
    ...opts,
  });
}
