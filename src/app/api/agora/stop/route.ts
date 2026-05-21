import { NextResponse } from 'next/server';
import { readActiveAgentId, stopConversationalAgent } from '@/lib/agora-agent-lifecycle';

export async function POST(req: Request) {
  let agentId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.agent_id && typeof body.agent_id === 'string') {
      agentId = body.agent_id;
    }
  } catch {
    /* no body */
  }

  if (!agentId) {
    agentId = readActiveAgentId();
  }

  if (!agentId) {
    return NextResponse.json({ error: 'No active agent' }, { status: 404 });
  }

  const stop = await stopConversationalAgent(agentId);
  if (!stop.ok) {
    return NextResponse.json({ error: 'Failed to stop agent', status: stop.status }, { status: 502 });
  }

  return NextResponse.json({ success: true, status: stop.status, agent_id: agentId });
}
