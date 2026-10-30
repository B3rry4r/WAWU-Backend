import { AiToolError } from '../ai-tools-error';
import { AiVoiceProviderError } from '../voice/ai-voice-provider';
import { asChat, type AiTool, type ChatInputSpec } from './ai-tool';

/** The plan's action a Receptionist text message is priced by (the PT1 tile's 20 points, PROVISIONAL, the owner sets it). */
export const RECEPTIONIST_MESSAGE_ACTION = 'receptionist_message';
/** The plan's action a talking session is priced by (400 a minute, in the plan file, no tile). */
export const RECEPTIONIST_VOICE_ACTION = 'receptionist_voice_per_min';
export const RECEPTIONIST_MESSAGE_MAX_SETTING =
  'ai.receptionist_message_max_chars';
export const RECEPTIONIST_LISTING_SETTING = 'ai.listed.receptionist';

export const MESSAGE_EMPTY_MESSAGE =
  'Write your message first. No points were taken.';

const INPUT: ChatInputSpec = {
  kind: 'chat',
  maxCharactersSetting: RECEPTIONIST_MESSAGE_MAX_SETTING,
};

/**
 * Receptionist (AITOOLS-06, R-109): a text message to the person's own talking agent, which answers from what they gave
 * it. Priced a message, by its plan action (a setting): no text a person reads may state a price. The agent and the
 * earlier messages are the Hub's own, found when the job runs; the reply is kept in the job as its text. Setting it up,
 * giving it knowledge and talking to it by voice are the routes under `/ai-tools/receptionist`.
 */
export const RECEPTIONIST_TOOL: AiTool = {
  id: 'receptionist',
  action: RECEPTIONIST_MESSAGE_ACTION,
  name: 'Receptionist',
  description: 'An assistant that answers from what you tell it.',
  unit: 'message',
  input: INPUT,
  audioFolder: null,
  listedWhenOff: false,
  listingSetting: RECEPTIONIST_LISTING_SETTING,
  enabled: (provider) => provider.agentsConfigured,
  check: (req, settings) => {
    const r = asChat(req);
    if (r.message === '')
      throw new AiToolError('ai_text_empty', MESSAGE_EMPTY_MESSAGE);
    const max = settings.number(RECEPTIONIST_MESSAGE_MAX_SETTING);
    if (r.characters > max)
      throw new AiToolError(
        'ai_prompt_too_long',
        `A message can have ${max} characters. This one has ${r.characters}. No points were taken.`,
        { cap: 'message_characters', capLimit: max, capUnit: 'characters' },
      );
  },
  price: (req) => ({ units: 1, characters: asChat(req).characters }),
  run: async (provider, _job, req, input) => {
    const r = asChat(req);
    if (!input?.chat)
      throw new AiVoiceProviderError('rejected', 'no receptionist');
    // REC-PRIVACY: the chat is a conversation the provider keeps. Its id is noted on the job the moment it is known
    // (so a run that dies still has it to delete) and handed back as the copy to delete once the job has ended.
    const { reply, conversationId } = await provider.askAgent(
      {
        agentId: input.chat.agentId,
        message: r.message,
        earlier: input.chat.earlier,
      },
      {
        onConversation: async (id) => {
          await input.noteCopy?.({ kind: 'conversation', id });
        },
      },
    );
    return {
      texts: [{ kind: 'text', text: reply }],
      chatTurn: { person: r.message, agent: reply },
      ...(conversationId !== ''
        ? {
            providerCopy: { kind: 'conversation' as const, id: conversationId },
          }
        : {}),
    };
  },
};
