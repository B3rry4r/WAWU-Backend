import type {
  AiVoiceProvider,
  StartedGeneration,
  StreamedFile,
} from '../voice/ai-voice-provider';
import { flowRef, type FlowKind } from '../flow/flow-support';
import type { AiToolRunInput, AiToolRunResult } from '../tools/ai-tool';

/**
 * The run of a Studio picture or video tool that sends the person's photo or
 * speech up first (AITOOLS-09, AITOOLS-10): upload each as an asset, note the
 * copy on the job at once so a server that dies still knows the provider holds
 * it, start the generation, and hand the job to the follower with the ids on its
 * row. The assets are deleted when the job ends, whatever the end (the pipeline
 * and the follower do that); here, only a run that never started cleans up what
 * could not be noted.
 */
export async function startWithAssets(
  provider: AiVoiceProvider,
  input: AiToolRunInput | undefined,
  kind: FlowKind,
  files: {
    photo?: () => Promise<StreamedFile>;
    speech?: () => Promise<StreamedFile>;
  },
  start: (ids: {
    photo: string | null;
    speech: string | null;
  }) => Promise<StartedGeneration>,
): Promise<AiToolRunResult> {
  const ids: string[] = [];
  let photo: string | null = null;
  let speech: string | null = null;
  /** True while the provider's copies are all noted on the job's row (the pipeline then owns their removal). */
  let noted = true;
  const note = async () => {
    noted =
      (await input?.noteCopy?.({ kind: 'asset', id: ids.join('+') })) === true;
  };
  try {
    if (files.photo) {
      photo = (
        await provider.uploadAsset({ file: await files.photo(), kind: 'photo' })
      ).assetId;
      ids.push(photo);
      await note();
    }
    if (files.speech) {
      speech = (
        await provider.uploadAsset({
          file: await files.speech(),
          kind: 'speech',
        })
      ).assetId;
      ids.push(speech);
      await note();
    }
    const started = await start({ photo, speech });
    return { follow: { ref: flowRef(kind, started.id, ids) } };
  } catch (e) {
    // A copy that could not be noted is removed here; one that was noted is removed by the pipeline.
    if (!noted)
      for (const id of ids)
        await provider.removeAsset(id).catch(() => undefined);
    throw e;
  }
}
