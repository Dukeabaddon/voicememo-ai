#!/usr/bin/env node
/**
 * Stop all RUNNING Agora conversational AI agents (saves trial minutes).
 * Usage: node scripts/stop-running-agents.mjs
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const appId = process.env.NEXT_PUBLIC_AGORA_APP_ID;
const customerId = process.env.AGORA_CUSTOMER_ID;
const customerSecret = process.env.AGORA_CUSTOMER_SECRET;

if (!appId || !customerId || !customerSecret) {
  console.error('Missing Agora credentials in .env.local');
  process.exit(1);
}

const auth = Buffer.from(`${customerId}:${customerSecret}`).toString('base64');
const listUrl = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents?state=2&limit=50`;

const listRes = await fetch(listUrl, { headers: { Authorization: `Basic ${auth}` } });
const listJson = await listRes.json();

if (!listRes.ok) {
  console.error('List failed:', listRes.status, listJson);
  process.exit(1);
}

const agents = listJson.data?.list ?? [];
console.log(`Found ${agents.length} RUNNING agent(s)`);

for (const { agent_id, status } of agents) {
  const leaveUrl = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${appId}/agents/${agent_id}/leave`;
  const res = await fetch(leaveUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
  });
  const body = await res.text();
  console.log(`${agent_id} (${status}) → leave ${res.status}: ${body.slice(0, 120)}`);
}

if (agents.length === 0) {
  console.log('Nothing to stop. Console UI may lag — refresh Session History.');
}
