import express from 'express';
import { getMcpToolAllowlist, getVoiceProfile } from './agora-voice-profile';
import { stopConversationalAgent } from './agora-agent-lifecycle';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDb } from './db-provider.js';
import type { IDatabase, Note } from './db.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.NEXT_PUBLIC_APP_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

const sseClients = new Set<express.Response>();

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function broadcastEvent(type: string, data: Record<string, unknown>, traceId?: string) {
  const payload = { ...data, traceId: traceId || null, ts: new Date().toISOString() };
  const message = `event: ${type}\nid: ${traceId || ''}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of sseClients) {
    client.write(message);
  }

  console.log(`[EVENT] emit ${type}`, JSON.stringify(payload));
}

function traceLog(traceId: string, stage: string, data?: Record<string, unknown>) {
  const payload = { stage, ...data };
  console.log(`[TRACE ${traceId}] ${stage}`, data ? JSON.stringify(data) : '');
  broadcastEvent('trace', payload, traceId);
}

type SessionState = {
  lastNoteId?: string;
  lastNoteContent?: string;
  lastTool?: string;
  emptyGetNotesStreak?: number;
  updatedAt?: string;
};

const SESSION_STATE_FILE = join(process.cwd(), 'data', 'session-state.json');

function readSessionState(): SessionState {
  try {
    const raw = readFileSync(SESSION_STATE_FILE, 'utf-8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return {};
  }
}

function writeSessionState(state: SessionState) {
  const dataDir = join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(SESSION_STATE_FILE, JSON.stringify(state, null, 2));
}

function updateSessionState(patch: SessionState) {
  const current = readSessionState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeSessionState(next);
  return next;
}

const LAST_NOTE_QUERY_RE = /^(last|previous|that|it|the note|this note)$/i;

function deriveTitleFromContent(content: string): string {
  const first = content.split(/\s*[—–\-]\s*|\n/)[0]?.trim() ?? content.trim();
  return first.slice(0, 120);
}

/** Keyword search, then session lastNoteId, then sole note in DB — avoids duplicate upserts on edit. */
async function resolveNoteForQuery(
  db: IDatabase,
  query: string
): Promise<{ note: Note | null; via?: string }> {
  const q = query.trim();
  if (!q) return { note: null };

  if (LAST_NOTE_QUERY_RE.test(q)) {
    const state = readSessionState();
    if (state.lastNoteId) {
      const notes = await db.getNotes(100);
      const hit = notes.find((n) => n.id === state.lastNoteId);
      if (hit) return { note: hit, via: 'last_query' };
    }
  }

  const byKeyword = await db.findNoteByKeyword(q);
  if (byKeyword) return { note: byKeyword, via: 'keyword' };

  const state = readSessionState();
  if (state.lastNoteId) {
    const notes = await db.getNotes(100);
    const hit = notes.find((n) => n.id === state.lastNoteId);
    if (hit) return { note: hit, via: 'session_last' };
  }

  const all = await db.getNotes(100);
  if (all.length === 1) return { note: all[0], via: 'only_note' };

  return { note: null };
}

const SAVE_INTENT_RE =
  /\b(save|note|remember|memo|remind|take a note|write down|don't forget)\b/i;
/** Only these reasons may stop the cloud agent — blocks "save note", "ending the call", etc. */
const EXPLICIT_GOODBYE_REASON_RE =
  /\b(goodbye|goodnight|bye\s|bye$|hang up|hang up the call|end call|end the call|end session|end the session|session end|stop call|stop the session|i'?m done|that'?s all)\b/i;
/** LLM meta-summaries — not real note body */
const META_SAVE_REASON_RE =
  /^(user (?:is )?)?requesting to save|wants? to save a note|save (?:a )?note|note request/i;

function noteTextFromTerminateReason(reason: string): string {
  const trimmed = reason.trim();
  const prefixes = [
    /^user wants to save a note about\s+/i,
    /^user wants to (?:save|remember)\s+/i,
    /^save a note about\s+/i,
    /^remember to\s+/i,
  ];
  let text = trimmed;
  for (const re of prefixes) {
    text = text.replace(re, '');
  }
  return text.trim() || trimmed;
}

// Tool definitions
const TOOLS = [
  {
    name: 'save_note',
    description:
      'Create a NEW note. REQUIRED when the user says save, remember, memo, or take a note. Put the user exact words in content (e.g. "Call mom at 5 PM — cat made a mess"), not a summary like "user wants to save".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          description: 'Verbatim note body from what the user said. Never tool/meta text.',
        },
        category: { type: 'string', description: 'Optional category: idea, task, meeting, reminder, general.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' }
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_notes',
    description: 'List notes. Use when the user asks to list or read notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', default: 10 },
        category: { type: 'string', description: 'Optional category filter.' }
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_notes',
    description: 'Search notes by keyword. Use when the user wants to find a specific note.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', minLength: 1, description: 'Search keyword or phrase.' },
        limit: { type: 'number', default: 5 }
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_note',
    description:
      'Delete ONLY when user explicitly says delete, remove, cancel, or don\'t need the note. Never for save/remember requests.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', minLength: 1, description: 'Keyword to find the note to delete.' }
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_note',
    description:
      'Change an EXISTING note. Use query "last" for the note just saved in this call, or a keyword. Never creates a duplicate — if unsure, call get_session_context first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Keyword, or "last" / "that" for the note from this session.',
        },
        new_content: { type: 'string', minLength: 1, description: 'Full updated note text from the user.' }
      },
      required: ['query', 'new_content'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_session_context',
    description: 'Get the last note/tool context for resolving references like "that note".',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'terminate_session',
    description:
      'End cloud voice agent when user says goodbye, bye, hang up, end call, end session, or that\'s all. Pass their exact phrase as reason.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'Reason for termination' }
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_website_context',
    description: 'Retrieve the current website data and app state.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  }
];

function emitNoteChunks(note: { id: string; content: string }, traceId: string) {
  const content = note.content || '';
  const chunkSize = 12;
  let index = 0;

  const interval = setInterval(() => {
    const chunk = content.slice(index, index + chunkSize);
    if (!chunk) {
      clearInterval(interval);
      broadcastEvent('note_complete', { noteId: note.id, content }, traceId);
      return;
    }
    broadcastEvent('append_note_chunk', { noteId: note.id, chunk }, traceId);
    index += chunkSize;
  }, 40);
}

// Tool execution logic
async function executeTool(name: string, args: Record<string, unknown> | undefined, traceId: string) {
  const db = getDb();
  traceLog(traceId, 'tool_execute_start', { name, args });

  switch (name) {
    case 'save_note': {
      const content = typeof args?.content === 'string' ? args.content.trim() : '';
      if (!content) {
        traceLog(traceId, 'tool_args_invalid', { reason: 'content missing' });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Missing content', traceId }) }], isError: true };
      }

      const doc = {
        content,
        category: (args?.category as string) || 'general',
        tags: (args?.tags as string[]) || [],
        title: '',
        source: 'ai' as const,
      };
      traceLog(traceId, 'db_write_start', { type: 'save_note' });
      try {
        const saved = await db.saveNote(doc);
        traceLog(traceId, 'db_write_success', { id: saved.id });
        updateSessionState({
          lastNoteId: saved.id,
          lastNoteContent: saved.content,
          lastTool: 'save_note',
          emptyGetNotesStreak: 0,
        });
        broadcastEvent('note_created', { note: saved }, traceId);
        emitNoteChunks({ id: saved.id, content: saved.content }, traceId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, noteId: saved.id, traceId }) }] };
      } catch (err) {
        console.error('[DB] Save failed:', err);
        traceLog(traceId, 'db_write_error', { error: 'save_note failed' });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Database error', traceId }) }], isError: true };
      }
    }

    case 'get_notes': {
      const limit = (args?.limit as number) || 10;
      const category = (args?.category as string) || 'all';
      traceLog(traceId, 'db_read_start', { type: 'get_notes', limit, category });
      const notes = await db.getNotes(limit, category);
      traceLog(traceId, 'db_read_success', { count: notes.length });
      const prev = readSessionState();
      const streak =
        notes.length === 0 && prev.lastTool === 'get_notes'
          ? (prev.emptyGetNotesStreak || 0) + 1
          : 0;
      updateSessionState({ lastTool: 'get_notes', emptyGetNotesStreak: streak });
      const payload: Record<string, unknown> = { ok: true, notes, traceId };
      if (notes.length === 0) {
        payload.hint = 'No notes yet. To store content call save_note with the user text.';
        if (streak >= 2) {
          payload.error = 'STOP_POLLING_USE_SAVE_NOTE';
          payload.ok = false;
        }
      } else {
        updateSessionState({ emptyGetNotesStreak: 0 });
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    }

    case 'search_notes': {
      const q = (args?.query as string) || '';
      if (!q.trim()) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Missing query', traceId }) }], isError: true };
      }
      traceLog(traceId, 'db_read_start', { type: 'search_notes', query: q });
      const notes = await db.searchNotes(q);
      traceLog(traceId, 'db_read_success', { count: notes.length });
      updateSessionState({ lastTool: 'search_notes' });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, notes, traceId }) }] };
    }

    case 'delete_note': {
      const q = (args?.query as string) || '';
      if (!q.trim()) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Missing query', traceId }) }], isError: true };
      }
      traceLog(traceId, 'db_read_start', { type: 'delete_note', query: q });
      const { note } = await resolveNoteForQuery(db, q);
      if (!note) {
        traceLog(traceId, 'db_read_success', { found: false });
        const existing = await db.getNotes(1);
        if (existing.length === 0 && q.length >= 12) {
          traceLog(traceId, 'delete_redirected_to_save', { reason: 'empty_db' });
          const saved = await db.saveNote({ content: q, category: 'general', source: 'ai' });
          updateSessionState({
            lastNoteId: saved.id,
            lastNoteContent: saved.content,
            lastTool: 'save_note',
            emptyGetNotesStreak: 0,
          });
          broadcastEvent('note_created', { note: saved }, traceId);
          emitNoteChunks({ id: saved.id, content: saved.content }, traceId);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                noteId: saved.id,
                redirectedFrom: 'delete_note',
                message: 'No note to delete; saved as new note. Use save_note for new content next time.',
                traceId,
              }),
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'Note not found',
              hint: 'If user wanted to save new text, call save_note with content = their words.',
              traceId,
            }),
          }],
        };
      }
      traceLog(traceId, 'db_write_start', { type: 'delete_note', id: note.id });
      await db.deleteNote(note.id);
      traceLog(traceId, 'db_write_success', { id: note.id });
      const state = readSessionState();
      if (state.lastNoteId === note.id) {
        updateSessionState({ lastNoteId: undefined, lastNoteContent: undefined, lastTool: 'delete_note' });
      } else {
        updateSessionState({ lastTool: 'delete_note' });
      }
      broadcastEvent('note_deleted', { noteId: note.id }, traceId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, noteId: note.id, traceId }) }] };
    }

    case 'update_note': {
      const q = (args?.query as string) || '';
      const newC = (args?.new_content as string) || '';
      if (!q.trim() || !newC.trim()) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Missing query or new_content', traceId }) }], isError: true };
      }
      traceLog(traceId, 'db_read_start', { type: 'update_note', query: q });
      const { note, via } = await resolveNoteForQuery(db, q);

      if (!note) {
        traceLog(traceId, 'db_read_success', { found: false });
        const existing = await db.getNotes(1);
        if (existing.length === 0) {
          const saved = await db.saveNote({
            content: newC,
            title: deriveTitleFromContent(newC),
            category: 'general',
            source: 'ai',
          });
          traceLog(traceId, 'db_write_success', { id: saved.id, created: true });
          updateSessionState({
            lastNoteId: saved.id,
            lastNoteContent: saved.content,
            lastTool: 'save_note',
            emptyGetNotesStreak: 0,
          });
          broadcastEvent('note_created', { note: saved }, traceId);
          emitNoteChunks({ id: saved.id, content: saved.content }, traceId);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                noteId: saved.id,
                created: true,
                hint: 'No notes yet; saved as new note. Use save_note next time.',
                traceId,
              }),
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'NOTE_NOT_FOUND',
              message: 'Use update_note with query "last", or get_session_context. New notes → save_note.',
              traceId,
            }),
          }],
          isError: true,
        };
      }

      traceLog(traceId, 'db_read_success', { found: true, id: note.id, via });
      const title = deriveTitleFromContent(newC);
      traceLog(traceId, 'db_write_start', { type: 'update_note', id: note.id });
      await db.updateNote(note.id, newC, title);
      const updated = { ...note, content: newC, title, updated_at: new Date().toISOString() };
      traceLog(traceId, 'db_write_success', { id: note.id });
      updateSessionState({ lastNoteId: note.id, lastNoteContent: newC, lastTool: 'update_note' });
      broadcastEvent('note_updated', { note: updated }, traceId);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, noteId: note.id, traceId }) }] };
    }

    case 'get_session_context': {
      const state = readSessionState();
      const allNotes = await db.getNotes(100);
      const noteCount = allNotes.length;
      traceLog(traceId, 'session_context', { state, noteCount });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            state,
            noteCount,
            hint: noteCount === 0 ? 'Database empty — use save_note for new content.' : undefined,
            traceId,
          }),
        }],
      };
    }

    case 'terminate_session': {
      const reason = (args?.reason as string) || 'User requested';
      traceLog(traceId, 'terminate_session', { reason });

      if (!EXPLICIT_GOODBYE_REASON_RE.test(reason)) {
        traceLog(traceId, 'terminate_blocked_not_goodbye', { reason });
        if (SAVE_INTENT_RE.test(reason)) {
          const content = noteTextFromTerminateReason(reason);
          if (!META_SAVE_REASON_RE.test(content) && content.length >= 12) {
            const saved = await db.saveNote({ content, category: 'general', source: 'ai' });
            updateSessionState({
              lastNoteId: saved.id,
              lastNoteContent: saved.content,
              lastTool: 'save_note',
            });
            broadcastEvent('note_created', { note: saved }, traceId);
            emitNoteChunks({ id: saved.id, content: saved.content }, traceId);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  noteId: saved.id,
                  redirectedFrom: 'terminate_session',
                  message: 'Saved. Stay on the call. Use terminate_session only after goodbye.',
                  traceId,
                }),
              }],
            };
          }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'NOT_GOODBYE',
              message:
                'Do not end the call. New content → save_note. Edits → update_note. Deletes → delete_note (explicit only).',
              traceId,
            }),
          }],
          isError: true,
        };
      }

      // Legacy redirect if model still calls terminate with save-ish reason (balanced profile)
      if (SAVE_INTENT_RE.test(reason)) {
        const content = noteTextFromTerminateReason(reason);
        if (META_SAVE_REASON_RE.test(content) || content.length < 12) {
          traceLog(traceId, 'terminate_redirect_rejected_meta', { reason });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'MISSING_NOTE_BODY',
                message:
                  'Wrong tool. Call save_note with content = user exact words (what they asked to remember), not a summary of the request.',
                traceId,
              }),
            }],
            isError: true,
          };
        }
        traceLog(traceId, 'terminate_redirected_to_save', { contentPreview: content.slice(0, 80) });
        const saved = await db.saveNote({
          content,
          category: 'general',
          source: 'ai',
        });
        updateSessionState({
          lastNoteId: saved.id,
          lastNoteContent: saved.content,
          lastTool: 'save_note',
          emptyGetNotesStreak: 0,
        });
        broadcastEvent('note_created', { note: saved }, traceId);
        emitNoteChunks({ id: saved.id, content: saved.content }, traceId);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              noteId: saved.id,
              redirectedFrom: 'terminate_session',
              message:
                'Note saved. Do NOT end the call. Tell the user briefly it is saved. Only use terminate_session after explicit goodbye.',
              traceId,
            }),
          }],
        };
      }

      const stop = await stopConversationalAgent();
      traceLog(traceId, 'session_end_completed', { agentStopped: stop.ok, agentId: stop.agentId });

      broadcastEvent('session_terminated', {
        reason,
        agentId: stop.agentId,
        agentStopped: stop.ok,
      }, traceId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            message: 'Session terminated. Goodnight, Admin.',
            agentStopped: stop.ok,
            traceId,
          }),
        }],
      };
    }

    case 'get_website_context': {
      const context = {
        url: "https://voicememo.ai/dashboard",
        active_view: "All Notes",
        user_role: "Admin",
        available_categories: ["idea", "task", "meeting", "reminder", "general"],
        system_status: "Operational"
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, context, traceId }) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create MCP Server instance with handlers
function createMcpServer(): Server {
  const srv = new Server(
    { name: 'voicememo-ai-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => {
    const traceId = generateTraceId();
    const allowlist = getMcpToolAllowlist(getVoiceProfile());
    const tools = allowlist
      ? TOOLS.filter((t) => allowlist.includes(t.name))
      : TOOLS;
    traceLog(traceId, 'tools_list_requested', { toolCount: tools.length, profile: getVoiceProfile() });
    const response = { tools };
    traceLog(traceId, 'tools_list_response', { tools: tools.map((t) => t.name) });
    return response;
  });

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const traceId = generateTraceId();
    traceLog(traceId, 'tool_selected', { name });
    traceLog(traceId, 'tool_arguments_parsed', { args });
    console.time(`tool_${name}`);
    try {
      const result = await executeTool(name, args, traceId);
      console.log(`[MCP] Tool result [${name}]:`, JSON.stringify(result, null, 2));
      console.timeEnd(`tool_${name}`);
      return result;
    } catch (error: unknown) {
      console.timeEnd(`tool_${name}`);
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[MCP] Tool error [${name}]:`, msg);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  });

  return srv;
}

// --- Streamable HTTP Transport (Agora-compatible) ---

app.post('/mcp', async (req, res) => {
  const traceId = String(req.body?.id || generateTraceId());
  console.log(`[MCP] Incoming POST /mcp request - Method: ${req.body?.method || 'unknown'} - Trace: ${traceId}`);
  traceLog(traceId, 'mcp_inbound_raw', { body: req.body || {} });

  if (req.body?.method === 'tools/call') {
    traceLog(traceId, 'mcp_tool_call_raw', { name: req.body.params?.name, arguments: req.body.params?.arguments || {} });
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  res.on('close', () => {
    transport.close();
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal MCP error' });
    }
  }
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = generateTraceId();
  sseClients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, ts: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write('event: heartbeat\ndata: {}\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Keep SSE endpoint for backward compatibility
app.get('/sse', (_req, res) => {
  res.status(200).json({ 
    message: 'This server uses Streamable HTTP transport. Use POST /mcp instead.',
    endpoint: '/mcp'
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', transport: 'streamable_http' });
});

const PORT = process.env.MCP_SERVER_PORT || 3001;
app.listen(PORT, () => {
  console.log(`[MCP] Server running at http://localhost:${PORT}/mcp`);
  console.log(`[MCP] Transport: Streamable HTTP (Agora-compatible)`);
  console.log(`[MCP] Using ${process.env.USE_MOCK_DB === 'true' ? 'Mock (file-based)' : 'Couchbase'} database`);
});
