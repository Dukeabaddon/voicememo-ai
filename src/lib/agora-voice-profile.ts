/**
 * Voice agent latency profiles (Siri-style: optimize time-to-first-audio).
 * AGORA_VOICE_PROFILE=fast | balanced (default fast for demos)
 */

export type VoiceProfile = 'fast' | 'balanced';

export function getVoiceProfile(): VoiceProfile {
  const v = (process.env.AGORA_VOICE_PROFILE || 'fast').toLowerCase();
  return v === 'balanced' ? 'balanced' : 'fast';
}

const PRESETS: Record<VoiceProfile, string> = {
  fast: 'deepgram_nova_3,openai_gpt_4_1_mini,minimax_speech_2_8_turbo',
  balanced: 'deepgram_nova_3,openai_gpt_5_mini,minimax_speech_2_8_turbo',
};

const LLM_MODEL: Record<VoiceProfile, string> = {
  fast: 'gpt-4.1-mini',
  balanced: 'gpt-4o-mini',
};

/** Tool names exposed to Agora MCP — fewer tools = faster list + fewer wrong calls */
const MCP_TOOLS: Record<VoiceProfile, string[] | null> = {
  // terminate_session only after explicit goodbye (server blocks save/edit reasons)
  fast: ['save_note', 'update_note', 'delete_note', 'get_session_context', 'terminate_session'],
  balanced: null,
};

export function getAgentPreset(profile: VoiceProfile): string {
  return process.env.AGORA_AGENT_PRESET || PRESETS[profile];
}

export function getLlmModel(profile: VoiceProfile): string {
  return process.env.OPENAI_LLM_MODEL || LLM_MODEL[profile];
}

const TOOL_LIST_ORDER = [
  'save_note',
  'update_note',
  'delete_note',
  'get_session_context',
  'terminate_session',
];

export function getMcpToolAllowlist(profile: VoiceProfile): string[] | null {
  const list = MCP_TOOLS[profile];
  if (!list) return null;
  return TOOL_LIST_ORDER.filter((name) => list.includes(name));
}

export function getSystemPrompt(profile: VoiceProfile): string {
  if (profile === 'fast') {
    return [
      'You are VoiceMemo, a voice note assistant for Admin. Short replies only.',
      'Tools: save_note, update_note, delete_note, get_session_context, terminate_session.',
      'DEFAULT for new info: save_note. User says save/remember/take a note → save_note with their exact words in content (e.g. "Call mom at 5 PM — cat made a mess").',
      'UPDATE when user changes/edits time or text on the note they just saved → update_note with query "last" and new_content = full updated sentence.',
      'If unsure which note: get_session_context once, then update_note with query "last".',
      'DELETE only if user explicitly says delete/remove/don\'t need/cancel the note → delete_note (query "last" ok). Never delete when user asks to save.',
      'After save/update/delete: confirm briefly and keep listening.',
      'END CALL: goodbye, bye, hang up, end call, end session, or that\'s all → terminate_session with their exact phrase as reason, then say "Goodnight, Admin."',
    ].join(' ');
  }

  return [
    'VoiceMemo AI assistant. Technical, direct, light humor.',
    'Notes only. Bullets when summarizing.',
    'save_note for new saves (under 800 chars). update_note only if a note already exists.',
    'Goodbye: save_note, terminate_session, "Goodnight, Admin."',
  ].join(' ');
}

export function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 12 && hour < 18) return 'Afternoon, Admin.';
  if (hour >= 18 && hour < 22) return 'Evening, Admin.';
  if (hour >= 22 || hour < 5) return 'Night, Admin.';
  return 'Morning, Admin.';
}

/** Agora /join properties that affect perceived latency (not in preset string) */
export function getLatencyProperties(profile: VoiceProfile): Record<string, unknown> {
  const fillerPhrases =
    profile === 'fast'
      ? ['Okay.', 'One sec.', 'Got it.']
      : ['Okay.', 'Let me check.', 'One moment.'];

  const responseWaitMs = profile === 'fast' ? 700 : 1200;

  return {
    filler_words: {
      enable: true,
      trigger: {
        mode: 'fixed_time',
        fixed_time_config: { response_wait_ms: responseWaitMs },
      },
      content: {
        mode: 'static',
        static_config: {
          phrases: fillerPhrases,
          selection_rule: 'shuffle',
        },
      },
    },
    turn_detection: {
      mode: 'default',
      config: { speech_threshold: profile === 'fast' ? 0.45 : 0.5 },
    },
    // Do NOT add silence_config action:"think" with 10s timeout — adds dead air
  };
}
