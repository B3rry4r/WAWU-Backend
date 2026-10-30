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
      seconds?: string;
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
  };
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
