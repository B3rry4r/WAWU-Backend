import type { AiTool, AiToolId } from './ai-tool';
import { QUICK_VOICE_TOOL } from './quick-voice.tool';
import { VOICEOVER_TOOL } from './voiceover.tool';

/**
 * THE TOOL REGISTRY (AITOOLS-02, R-78). The tools the Hub can run, in the
 * order Studio lists them. A tool is here only once its code is built: the
 * next tasks add one file and one entry each (AITOOLS-03 to -06). `GET
 * /ai-tools` lists from here, and every `POST /ai-tools/{id}/jobs` route
 * hands its tool to the one pipeline.
 */
export const AI_TOOLS: readonly AiTool[] = [VOICEOVER_TOOL, QUICK_VOICE_TOOL];

/** The tool whose plan action a job row names (`tool` column), or null for an action no built tool prices. */
export function toolForAction(action: string): AiTool | null {
  return AI_TOOLS.find((t) => t.action === action) ?? null;
}

export function toolById(id: AiToolId): AiTool {
  const tool = AI_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`no AI tool with id ${id}`);
  return tool;
}
