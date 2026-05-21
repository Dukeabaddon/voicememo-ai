import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const AGENT_FILE = join(process.cwd(), 'data', 'active-agent.json');

export function readActiveAgentId(): string | null {
  try {
    const data = JSON.parse(readFileSync(AGENT_FILE, 'utf-8'));
    return data.agent_id || data.name || null;
  } catch {
    return null;
  }
}

export function clearActiveAgentFile(): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(AGENT_FILE, JSON.stringify({ agent_id: null, stopped: Date.now() }, null, 2));
  } catch {
    /* ignore */
  }
}

/** Stop Agora Conversational AI agent via REST leave */
export async function stopConversationalAgent(agentId?: string | null): Promise<{
  ok: boolean;
  status?: number;
  agentId?: string | null;
}> {
  const appId = process.env.NEXT_PUBLIC_AGORA_APP_ID;
  const customerId = process.env.AGORA_CUSTOMER_ID;
  const customerSecret = process.env.AGORA_CUSTOMER_SECRET;
  const id = agentId || readActiveAgentId();

  if (!appId || !customerId || !customerSecret || !id) {
    return { ok: false, agentId: id };
  }

  try {
    const auth = Buffer.from(`${customerId}:${customerSecret}`).toString('base64');
    const stopUrl = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents/${id}/leave`;
    const res = await fetch(stopUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    console.log(`[AGORA] Agent stop ${id}: ${res.status}`, JSON.stringify(data));
    clearActiveAgentFile();
    return { ok: res.ok, status: res.status, agentId: id };
  } catch (err) {
    console.error('[AGORA] Agent stop failed:', err);
    return { ok: false, agentId: id };
  }
}
