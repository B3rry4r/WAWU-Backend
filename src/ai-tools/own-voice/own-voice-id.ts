/**
 * The voice id a VoiceOver job names to be read in the person's own voice
 * (AITOOLS-07, G-AITOOLS-01-1). It is not in `GET /ai-tools`'s voice list: the
 * app draws it as the first row ("Your voice") only when `GET
 * /ai-tools/own-voice` says `ready`.
 */
export const OWN_VOICE_ID = 'own';
