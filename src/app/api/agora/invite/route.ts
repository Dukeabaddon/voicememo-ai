import { NextRequest, NextResponse } from 'next/server';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildInvitePayload } from '@/lib/agora-invite-payload';
import { getGreeting, getSystemPrompt, getVoiceProfile } from '@/lib/agora-voice-profile';

export async function POST(req: NextRequest) {
  const { channelName, userUid } = await req.json();
  
  const appId = process.env.NEXT_PUBLIC_AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  const customerId = process.env.AGORA_CUSTOMER_ID;
  const customerSecret = process.env.AGORA_CUSTOMER_SECRET;
  // pipeline_id = Agent ID from Console → Agents (same value as Studio curl example)
  const pipelineId = process.env.AGORA_AGENT_ID || process.env.AGORA_CONVERSATIONAL_AI_KEY;

  if (!appId || !appCertificate || !customerId || !customerSecret || !pipelineId) {
    console.error('[INVITE] Missing credentials:', { appId: !!appId, appCertificate: !!appCertificate, customerId: !!customerId, customerSecret: !!customerSecret, pipelineId: !!pipelineId });
    return NextResponse.json({ error: 'Agora credentials missing' }, { status: 500 });
  }

  if (pipelineId === customerId || pipelineId === process.env.AGORA_CUSTOMER_SECRET) {
    console.error('[INVITE] AGORA_AGENT_ID must be Agent Studio pipeline ID, not REST customer credentials');
    return NextResponse.json(
      { error: 'AGORA_AGENT_ID must be the Agent ID from Console → Agents (pipeline_id in /join), not Customer ID/Secret' },
      { status: 400 }
    );
  }

  const profile = getVoiceProfile();
  const greeting = getGreeting();
  const systemPrompt = getSystemPrompt(profile);

  try {
    const auth = Buffer.from(`${customerId}:${customerSecret}`).toString('base64');
    
    // Generate token for agent UID 100
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    const agentUid = 100; 

    const agentToken = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      agentUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs,
      privilegeExpiredTs
    );

    const url = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/join`;
    const mcpEndpoint = process.env.MCP_SERVER_URL || 'http://localhost:3001/mcp';

    const payload = buildInvitePayload({
      pipelineId,
      channelName,
      agentToken,
      agentUid,
      userUid: userUid ?? 0,
      greeting,
      systemPrompt,
      mcpEndpoint,
    });

    console.log('[INVITE] Sending to Agora:', url);
    console.log('[INVITE] voice profile:', profile, '| preset:', payload.preset);
    console.log('[INVITE] remote_rtc_uids:', payload.properties.remote_rtc_uids);
    console.log('[INVITE] MCP endpoint:', mcpEndpoint);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log('[INVITE] Agora response:', response.status, JSON.stringify(data));

    if (!response.ok) {
      console.error('[INVITE] Agora FULL error:', JSON.stringify(data, null, 2));
      const nested = typeof data.detail === 'string' && data.detail.includes('msg:')
        ? data.detail
        : data.msg || data.message;
      throw new Error(nested || data.detail || data.reason || `Agora API error: ${response.status}`);
    }

    const sessionAgentId = data.agent_id as string | undefined;
    if (sessionAgentId) {
      try {
        const dataDir = join(process.cwd(), 'data');
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(
          join(dataDir, 'active-agent.json'),
          JSON.stringify({ agent_id: sessionAgentId, channel: channelName, started: Date.now() }, null, 2)
        );
      } catch (e) {
        console.warn('[INVITE] Could not persist active-agent.json:', e);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error('[INVITE] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
