import { Logger } from '@nestjs/common';
import { AI_STEMS_FOLDER } from '../audio/ai-audio-store';
import { looksLikeMp3, stemLabelOf, stemSlug } from '../music/stem-names';
import { readZip, ZipRefused } from '../music/zip-reader';
import {
  asFile,
  type AiTool,
  type AiToolRunResult,
  type FileInputSpec,
} from './ai-tool';
import { checkFileLimits } from './file-limits';
import { requireAtMostSeconds, requireKind } from './file-checks';

/** The plan's action a Split a song job is priced by (a flat price a song, PROVISIONAL `STUDIO2-PLACEHOLDER`). */
export const STEMS_ACTION = 'stems_per_song';
export const STEMS_MAX_SECONDS_SETTING = 'ai.stems_max_seconds';

const INPUT: FileInputSpec = {
  kind: 'file',
  languageCode: false,
  only: 'audio',
  parts: [2, 6],
  maxSecondsSetting: STEMS_MAX_SECONDS_SETTING,
};

const logger = new Logger('SplitSong');

/**
 * Split a song (AITOOLS-12, R-109): the person's own song goes in, two parts (the voice and the rest) or six come back,
 * each as its own audio file with a plain name. One long synchronous call. The provider answers ONE ZIP: the Hub opens
 * it with its own strict reader (`readZip`: entry count, total size, a zip bomb, path names never trusted), keeps only
 * entries that are really MP3 audio, and stores each under a key of its own, never under a name from the archive. An
 * archive the reader refuses, or one with no audio in it, fails the job and every point goes back. Priced flat, one
 * song, by its own setting: no text a person reads may state or imply a price.
 */
export const STEMS_TOOL: AiTool = {
  id: 'stems',
  action: STEMS_ACTION,
  name: 'Split a song',
  description: 'Pull a song apart into its voice and instruments.',
  unit: 'use',
  input: INPUT,
  audioFolder: AI_STEMS_FOLDER,
  listedWhenOff: false,
  listingSetting: 'ai.listed.stems',
  enabled: (provider) => provider.fileToolsConfigured,
  checkFile: (opened, settings) => {
    requireKind(opened, 'audio');
    requireAtMostSeconds(opened, settings, STEMS_MAX_SECONDS_SETTING, 'song');
  },
  check: (req, _settings, plan) => checkFileLimits(req, plan),
  quoteUnits: () => 1,
  price: () => ({ units: 1, characters: 0 }),
  run: async (provider, _job, req, input) => {
    const r = asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    const { archive } = await provider.splitStems({
      file: input.file,
      parts: r.parts === 6 ? 6 : 2,
    });
    let files;
    try {
      files = readZip(archive);
    } catch (e) {
      logger.warn(
        `a stem archive was refused (${e instanceof ZipRefused ? e.reason : 'unreadable'})`,
      );
      return { failure: 'output_shape' };
    }
    const audios: NonNullable<AiToolRunResult['audios']> = [];
    let unnamed = 0;
    for (const f of files) {
      if (!looksLikeMp3(f.data)) continue;
      let label = stemLabelOf(f.name);
      if (label === null) {
        unnamed += 1;
        label = `Part ${audios.length + 1}`;
      }
      audios.push({
        label,
        slug: stemSlug(label, audios.length),
        audio: { audio: f.data, contentType: 'audio/mpeg' },
      });
    }
    if (unnamed > 0)
      logger.warn(
        `${unnamed} stem file(s) had a name the table does not know (the proof call reads the real names)`,
      );
    if (audios.length === 0) return { failure: 'output_type' };
    return { audios };
  },
};
