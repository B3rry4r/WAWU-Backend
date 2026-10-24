import {
  DUB_ACTION_ID,
  DUB_MAX_RUN_SETTING,
} from '../../points/spend/points-hold-sweep.service';
import { AI_DUBBING_FOLDER } from '../audio/ai-audio-store';
import { AiToolError } from '../ai-tools-error';
import { dubLanguagesOf, findDubLanguage, followRef } from '../dub/dub-support';
import { asFile, type AiTool } from './ai-tool';
import { checkFileLimits } from './file-limits';

/** The plan's action a Dubbing job is priced by: a price for each minute of the file in each language (PROVISIONAL, the PT1 tile "From"). */
export const DUBBING_ACTION = DUB_ACTION_ID;
/** The languages Dubbing offers: the provider's own list, an admin setting (PROVISIONAL `AITOOLS-DUB-LANGUAGES`). */
export const DUBBING_LANGUAGES_SETTING = 'ai.dubbing_languages';
/** How long a dub may stay working before its points are given back (PROVISIONAL `AITOOLS-DUB-RUN`). */
export const DUBBING_MAX_RUN_SETTING = DUB_MAX_RUN_SETTING;

export const LANGUAGE_UNSUPPORTED_MESSAGE =
  "That language isn't on the list. Pick one from the list. No points were taken.";
export const LANGUAGE_SAME_MESSAGE =
  'Pick a language other than the one spoken in the recording. No points were taken.';

/**
 * Dubbing (AITOOLS-05, PT1 "Dubbing"): a recording or video the person
 * uploaded goes in with the language to hear it in, and the dubbed audio and
 * its subtitles come back. The one slow tool: the provider takes the file and
 * works on it for minutes, so the job stays `working` while the Hub follows it
 * (`AiDubService`) and the person can leave and come back.
 *
 * Priced by the minute of the file as the Hub reads it, for ONE language (one
 * language a job: a second language is a second job). The price is the plan's
 * own setting (R-65), so no text a person reads may state or imply a price. The
 * premium dub is not built: no board draws a choice and the provider pages do
 * not say what premium means (G-AITOOLS-05-2).
 *
 * `run` only STARTS the provider's project; what follows (the read of the
 * language target, the outputs, the commit or the release, deleting the
 * project) is the follower's.
 */
export const DUBBING_TOOL: AiTool = {
  id: 'dubbing',
  action: DUBBING_ACTION,
  name: 'Dubbing',
  description: 'Hear a recording or video again in another language.',
  unit: 'minute',
  input: { kind: 'file', languageCode: false, dubbing: true },
  audioFolder: AI_DUBBING_FOLDER,
  audioExtension: 'flac',
  listedWhenOff: false,
  enabled: (provider) => provider.fileToolsConfigured,
  precheck: (req, settings) => {
    const file = asFile(req);
    const list = dubLanguagesOf(settings.lines(DUBBING_LANGUAGES_SETTING));
    const target = findDubLanguage(list, file.targetLanguage ?? '');
    const source =
      file.sourceLanguage == null
        ? null
        : findDubLanguage(list, file.sourceLanguage);
    if (!target || (file.sourceLanguage != null && !source))
      throw new AiToolError(
        'ai_language_unsupported',
        LANGUAGE_UNSUPPORTED_MESSAGE,
      );
    if (source && source.code === target.code)
      throw new AiToolError('ai_language_unsupported', LANGUAGE_SAME_MESSAGE);
    return {
      ...file,
      targetLanguage: target.code,
      sourceLanguage: source ? source.code : null,
    };
  },
  check: (req, _settings, plan) => checkFileLimits(req, plan),
  // One language a job: the unit is a minute for each language, and each job has one.
  price: (req) => ({ units: asFile(req).minutes * 1, characters: 0 }),
  run: async (provider, _job, req, input) => {
    const { targetLanguage, sourceLanguage } = asFile(req);
    if (!input) throw new Error('a file tool was run without its file');
    if (!targetLanguage) throw new Error('a dub was run without its language');
    const started = await provider.startDub({
      file: input.file,
      targetLanguage,
      sourceLanguage: sourceLanguage ?? null,
    });
    // The provider made a project but named no language to follow on: the job
    // ends and the project is deleted (the pipeline notes and discards it).
    if (started.languageId === null)
      return {
        failure: 'provider_unavailable',
        providerCopy: { kind: 'dub', id: started.projectId },
      };
    return {
      follow: { ref: followRef(started.projectId, started.languageId) },
    };
  },
};
