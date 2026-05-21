/**
 * Build Agora Conversational AI /join payload.
 * TTS: use Agora managed preset (fixes WebSocket HTTP 200) or BYOK MiniMax with key + group_id.
 * Latency: see agora-voice-profile.ts + docs/AGORA-LATENCY.md
 */

import {
  getAgentPreset,
  getLatencyProperties,
  getLlmModel,
  getVoiceProfile,
} from './agora-voice-profile';

/** MiniMax voice_id — Studio "Arrogant Miss" */
const DEFAULT_VOICE_ID = 'Arrogant_Miss';

export type InvitePayloadInput = {
  pipelineId: string;
  channelName: string;
  agentToken: string;
  agentUid?: number;
  userUid: string | number;
  greeting: string;
  systemPrompt: string;
  mcpEndpoint: string;
};

export function buildInvitePayload(input: InvitePayloadInput) {
  const profile = getVoiceProfile();
  const agentUid = input.agentUid ?? 100;
  const remoteUid = String(input.userUid);
  const preset = getAgentPreset(profile);

  const minimaxKey = process.env.MINIMAX_API_KEY;
  const minimaxGroupId = process.env.MINIMAX_GROUP_ID;
  const useStudioVoice =
    process.env.AGORA_USE_STUDIO_VOICE === 'true' || process.env.AGORA_USE_STUDIO_VOICE === '1';
  const voiceId = process.env.AGORA_TTS_VOICE_ID || DEFAULT_VOICE_ID;

  const properties: Record<string, unknown> = {
    channel: input.channelName,
    token: input.agentToken,
    agent_rtc_uid: String(agentUid),
    remote_rtc_uids: [remoteUid],
    enable_string_uid: false,
    idle_timeout: 120,
    advanced_features: {
      enable_tools: true,
    },
    ...getLatencyProperties(profile),
    llm: {
      greeting_message: input.greeting,
      failure_message: 'Hang on.',
      system_messages: [
        {
          role: 'system',
          content: input.systemPrompt,
        },
      ],
      mcp_servers: [
        {
          name: 'voicememo-mcp',
          endpoint: input.mcpEndpoint,
          transport: 'streamable_http',
        },
      ],
    },
  };

  // Skip TTS override → use voice from republished Agent Studio (Models tab)
  if (!useStudioVoice) {
    if (minimaxKey && minimaxGroupId) {
      properties.tts = {
        vendor: 'minimax',
        params: {
          key: minimaxKey,
          group_id: minimaxGroupId,
          model: process.env.MINIMAX_TTS_MODEL || 'speech-02-turbo',
          url: process.env.MINIMAX_TTS_URL || 'wss://api-uw.minimax.io/ws/v1/t2a_v2',
          voice_setting: {
            voice_id: voiceId,
          },
          audio_setting: {
            sample_rate: 16000,
          },
        },
      };
    } else {
      properties.tts = {
        params: {
          voice_setting: {
            voice_id: voiceId,
          },
        },
      };
    }
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const llm = properties.llm as Record<string, unknown>;
    llm.api_key = openaiKey;
    llm.url = 'https://api.openai.com/v1/chat/completions';
    llm.params = { model: getLlmModel(profile) };
  }

  return {
    name: `agent_${Date.now()}`,
    pipeline_id: input.pipelineId,
    preset,
    properties,
  };
}
