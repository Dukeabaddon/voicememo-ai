'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { IAgoraRTCClient, ILocalAudioTrack } from 'agora-rtc-sdk-ng';

interface Note {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  content: string;
  category: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
  type?: 'note';
  source?: 'manual' | 'ai';
  isNew?: boolean;
}

export default function VoiceMemoPage() {
  const [client, setClient] = useState<IAgoraRTCClient | null>(null);
  const [localTrack, setLocalTrack] = useState<ILocalAudioTrack | null>(null);
  const [joined, setJoined] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [displayNotes, setDisplayNotes] = useState<Note[]>([]);
  const [typingId, setTypingId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected' | 'error'>('idle');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [agoraInstance, setAgoraInstance] = useState<any>(null);
  const [isClient, setIsClient] = useState(false);
  const filtersRef = useRef({ searchQuery: '', activeCategory: 'all' });
  const activeAgentIdRef = useRef<string | null>(null);
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTrackRef = useRef<ILocalAudioTrack | null>(null);
  const endingSessionRef = useRef(false);
  const endSessionRef = useRef<(source: string, opts?: { skipAgentStop?: boolean }) => Promise<void>>(
    async () => {}
  );
  
  // Manual Note States
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newNote, setNewNote] = useState({
    title: '',
    name: 'Admin',
    description: '',
    content: '',
    category: 'general'
  });

  // Live Transcript States
  const [transcript, setTranscript] = useState<string>('');
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);

  // Hydration fix
  useEffect(() => {
    setIsClient(true);
    const initAgora = async () => {
      try {
        const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
        setAgoraInstance(AgoraRTC);
      } catch (err) {
        console.error('Agora load failed', err);
      }
    };
    initAgora();
  }, []);

  useEffect(() => {
    filtersRef.current = { searchQuery, activeCategory };
  }, [searchQuery, activeCategory]);

  const upsertNote = useCallback((note: Note) => {
    setNotes(prev => {
      const idx = prev.findIndex(n => n.id === note.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...note };
        return next;
      }
      return [note, ...prev];
    });

    setDisplayNotes(prev => {
      const idx = prev.findIndex(n => n.id === note.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...note };
        return next;
      }
      return [note, ...prev];
    });
  }, []);

  const removeNote = useCallback((id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
    setDisplayNotes(prev => prev.filter(n => n.id !== id));
  }, []);

  // Fetch notes from Couchbase via internal API
  const fetchNotes = useCallback(async (query?: string, category?: string) => {
    try {
      let url = '/api/notes';
      const params = new URLSearchParams();
      if (query) params.append('q', query);
      if (category && category !== 'all') params.append('category', category);

      const queryString = params.toString();
      if (queryString) url += `?${queryString}`;

      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[FETCH] /api/notes returned ${res.status}`);
        return;
      }
      const data: Note[] = await res.json();

      if (Array.isArray(data)) {
        setNotes(data.map(n => ({ ...n, isNew: false })));
        if (!typingId) {
          setDisplayNotes(data.map(n => ({ ...n, isNew: false })));
        }
      }
    } catch (err: any) {
      console.error('Fetch failed', err);
    }
  }, [typingId]);

  // Event-driven note updates are handled via SSE

  useEffect(() => {
    if (isClient) {
      fetchNotes(searchQuery, activeCategory);
    }
  }, [fetchNotes, isClient, searchQuery, activeCategory]);

  // Fallback if SSE misses events while agent saves via MCP
  useEffect(() => {
    if (!joined || !isClient) return;
    const id = setInterval(() => fetchNotes(searchQuery, activeCategory), 8000);
    return () => clearInterval(id);
  }, [joined, isClient, fetchNotes, searchQuery, activeCategory]);

  const endSession = useCallback(async (source: string, opts?: { skipAgentStop?: boolean }) => {
    if (endingSessionRef.current) return;
    endingSessionRef.current = true;

    const agentId = activeAgentIdRef.current;
    console.log('[SESSION] ending', { source, agentId, skipAgentStop: opts?.skipAgentStop });

    setJoined(false);
    setStatus('idle');
    setTranscript('');
    setIsAiSpeaking(false);

    if (!opts?.skipAgentStop && agentId) {
      fetch('/api/agora/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId }),
      }).catch((err) => console.warn('[STOP] Failed:', err));
    }
    activeAgentIdRef.current = null;

    const track = localTrackRef.current;
    const rtc = clientRef.current;
    localTrackRef.current = null;
    clientRef.current = null;
    setLocalTrack(null);
    setClient(null);

    try {
      if (track) {
        track.stop();
        track.close();
      }
      if (rtc) {
        await rtc.leave();
      }
    } catch (err) {
      console.warn('[SESSION] RTC cleanup error:', err);
    }

    endingSessionRef.current = false;
  }, []);

  useEffect(() => {
    endSessionRef.current = endSession;
  }, [endSession]);

  useEffect(() => {
    if (!isClient) return;

    const eventsUrl = process.env.NEXT_PUBLIC_MCP_EVENTS_URL || 'http://localhost:3001/events';
    const es = new EventSource(eventsUrl);

    es.addEventListener('connected', (event) => {
      console.log('[EVENT] Connected', (event as MessageEvent).data);
    });

    es.addEventListener('trace', (event) => {
      console.log('[TRACE]', (event as MessageEvent).data);
    });

    es.addEventListener('note_created', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const note: Note = payload.note;
      const { searchQuery: q, activeCategory: c } = filtersRef.current;

      console.log('[EVENT] note_created', payload.traceId, note.id);
      if (c !== 'all' && note.category !== c) return;
      if (q && !note.content.toLowerCase().includes(q.toLowerCase()) && !(note.title || '').toLowerCase().includes(q.toLowerCase())) return;

      setTypingId(note.id);
      upsertNote(note);
      setDisplayNotes(prev => {
        const idx = prev.findIndex(n => n.id === note.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], content: '', isNew: true };
          return next;
        }
        return [{ ...note, content: '', isNew: true }, ...prev];
      });
    });

    es.addEventListener('append_note_chunk', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const { noteId, chunk } = payload;
      console.log('[EVENT] append_note_chunk', payload.traceId, noteId, chunk);

      setDisplayNotes(prev => {
        const idx = prev.findIndex(n => n.id === noteId);
        if (idx < 0) return prev;
        const next = [...prev];
        const current = next[idx];
        next[idx] = { ...current, content: `${current.content || ''}${chunk}` };
        return next;
      });
    });

    es.addEventListener('note_complete', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const { noteId, content } = payload;
      console.log('[EVENT] note_complete', payload.traceId, noteId);
      setTypingId((current) => (current === noteId ? null : current));
      setDisplayNotes(prev => prev.map(n => n.id === noteId ? { ...n, content, isNew: false } : n));
    });

    es.addEventListener('note_updated', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const note: Note = payload.note;
      console.log('[EVENT] note_updated', payload.traceId, note.id);
      upsertNote(note);
    });

    es.addEventListener('note_deleted', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      console.log('[EVENT] note_deleted', payload.traceId, payload.noteId);
      removeNote(payload.noteId);
    });

    es.addEventListener('session_terminated', (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      console.log('[EVENT] session_terminated', payload.traceId, payload.reason);
      void endSessionRef.current('mcp_sse', { skipAgentStop: true });
    });

    es.onerror = () => {
      if (es.readyState === EventSource.OPEN) return;
      if (es.readyState === EventSource.CONNECTING) return;
      console.warn('[EVENT] SSE closed', { url: eventsUrl, online: navigator.onLine });
    };

    return () => {
      es.close();
    };
  }, [isClient, removeNote, upsertNote]);

  useEffect(() => {
    if (!isClient) return;
    if (process.env.NEXT_PUBLIC_LOG_RELAY !== 'true') return;

    const sessionId = `brave_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const endpoint = '/api/debug/logs';
    const allowList = [/\/api\/agora/, /\/api\/notes/, /\/events/];

    const shouldLogUrl = (url: string) => allowList.some(rx => rx.test(url));
    const toSafeString = (value: unknown) => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      try { return JSON.stringify(value); } catch { return String(value); }
    };

    const sendLog = (payload: Record<string, unknown>) => {
      const body = JSON.stringify({ sessionId, ...payload });
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([body], { type: 'application/json' });
          navigator.sendBeacon(endpoint, blob);
          return;
        }
      } catch {}

      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    };

    const originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
    };

    (['log', 'warn', 'error', 'info'] as const).forEach((level) => {
      console[level] = (...args: unknown[]) => {
        originalConsole[level](...args);
        sendLog({ type: 'console', level, args: args.map(toSafeString) });
      };
    });

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const start = performance.now();
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      const method = init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');

      const res = await originalFetch(input, init);
      const durationMs = Math.round(performance.now() - start);

      if (url && !url.includes(endpoint) && shouldLogUrl(url)) {
        sendLog({ type: 'fetch', url, method, status: res.status, durationMs });
      }

      return res;
    };

    const handleError = (event: ErrorEvent) => {
      sendLog({ type: 'error', message: event.message, source: event.filename, line: event.lineno, col: event.colno });
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      sendLog({ type: 'unhandledrejection', reason: toSafeString(event.reason) });
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    sendLog({ type: 'relay_started', userAgent: navigator.userAgent });

    return () => {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      window.fetch = originalFetch;
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, [isClient]);

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newNote, source: 'manual' }),
      });
      if (res.ok) {
        setShowCreateModal(false);
        setNewNote({ title: '', name: 'Admin', description: '', content: '', category: 'general' });
        fetchNotes(searchQuery, activeCategory);
      }
    } catch (err) {
      console.error('Create failed', err);
    }
  };

  const handleUpdateNote = async (id: string, content: string) => {
    try {
      const res = await fetch('/api/notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, content }),
      });

      if (res.ok) {
        setEditingNoteId(null);
        fetchNotes(searchQuery, activeCategory);
      }
    } catch (err) {
      console.error('Update failed', err);
    }
  };

  const handleDeleteNote = async (id: string) => {
    if (!confirm('Are you sure you want to delete this note?')) return;
    try {
      const res = await fetch(`/api/notes?id=${id}`, { method: 'DELETE' });
      if (res.ok) fetchNotes(searchQuery, activeCategory);
    } catch (err) {
      console.error('Delete failed', err);
    }
  };

  const joinCall = async () => {
    if (!agoraInstance) return;
    setStatus('joining');
    try {
      const userUid = Math.floor(Math.random() * 1000000000) + 1;
      const tokenRes = await fetch(`/api/agora/token?channelName=voicememo&uid=${userUid}`);
      const { token } = await tokenRes.json();
      const appId = process.env.NEXT_PUBLIC_AGORA_APP_ID;
      if (!appId) throw new Error('App ID missing');

      const rtcClient = agoraInstance.createClient({ mode: 'rtc', codec: 'vp8' });
      
      // Handle Real-time Transcription & Metadata
      rtcClient.on('stream-message', (uid: any, data: any) => {
        try {
          const decodedData = new TextDecoder().decode(data);
          // Skip binary protocol messages — only parse JSON objects
          if (!decodedData.startsWith('{') && !decodedData.startsWith('[')) return;
          
          const message = JSON.parse(decodedData);

          if (message.object === 'asr.result') {
            setTranscript(message.text);
            setIsAiSpeaking(false);
          } else if (message.object === 'tts.event' && message.event === 'started') {
            setIsAiSpeaking(true);
          } else if (message.object === 'tts.event' && message.event === 'stopped') {
            setIsAiSpeaking(false);
          }
        } catch {
          // Silently ignore malformed messages
        }
      });

      const AGENT_RTC_UID = 100;

      const playAgentAudio = async (user: any, mediaType: string) => {
        const uid = Number(user.uid);
        if (uid !== AGENT_RTC_UID) return;
        try {
          await rtcClient.subscribe(user, mediaType as 'audio' | 'video');
          if (mediaType === 'audio' && user.audioTrack) {
            user.audioTrack.play();
            console.log('[AUDIO] Agent track playing, uid', uid);
          }
        } catch (err) {
          console.warn('[AUDIO] Subscribe error:', err);
        }
      };

      rtcClient.on('user-published', (user: any, mediaType: string) => {
        void playAgentAudio(user, mediaType);
      });

      rtcClient.on('user-info-updated', (uid: number, msg: string) => {
        if (Number(uid) !== AGENT_RTC_UID) return;
        console.log('[AUDIO] Agent state:', msg);
        if (msg === 'unmute-audio') {
          const remote = rtcClient.remoteUsers.find((u: { uid: number }) => Number(u.uid) === AGENT_RTC_UID);
          if (remote?.hasAudio) {
            void playAgentAudio(remote, 'audio');
          }
        }
      });

      // Do NOT end session on user-unpublished — agent mutes/unpublishes audio during normal startup.
      rtcClient.on('user-unpublished', (user: any, mediaType: string) => {
        console.log('[RTC] Remote user unpublished:', user.uid, mediaType);
      });

      rtcClient.on('user-left', (user: any) => {
        console.log('[RTC] Remote user left channel:', user.uid);
        if (Number(user.uid) === AGENT_RTC_UID) {
          void endSessionRef.current('agent_left_rtc', { skipAgentStop: true });
        }
      });

      const uid = await rtcClient.join(appId, 'voicememo', token, userUid);
      
      const audioTrack = await agoraInstance.createMicrophoneAudioTrack();
      await rtcClient.publish(audioTrack);

      console.log('[SYSTEM] Voice agent starting... initiating proactive greeting.');
      console.log('Inviting AI Agent to channel:', 'voicememo', 'for user UID:', uid);
      const inviteRes = await fetch('/api/agora/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelName: 'voicememo', userUid: uid.toString() }),
      });
      
      const inviteData = await inviteRes.json();
      console.log('Agent invite response status:', inviteRes.status);
      console.log('Agent invite response data:', inviteData);

      if (!inviteRes.ok) {
        throw new Error(inviteData?.error || `Agent invite failed (${inviteRes.status})`);
      }

      activeAgentIdRef.current = inviteData?.data?.agent_id ?? null;

      clientRef.current = rtcClient;
      localTrackRef.current = audioTrack;
      setClient(rtcClient);
      setLocalTrack(audioTrack);
      setJoined(true);
      setStatus('connected');
    } catch (err) {
      console.error(err);
      setStatus('error');
    }
  };

  const leaveCall = async () => {
    await endSession('user_button');
  };

  if (!isClient) return null;

  return (
    <div className="flex h-screen bg-white text-zinc-900 font-sans selection:bg-zinc-200">
      {/* Sidebar: Claude Style */}
      <aside className="w-64 border-r border-zinc-100 flex flex-col bg-zinc-50/50">
        <div className="p-6">
          <div className="flex items-center gap-2 mb-8">
            <div className="w-8 h-8 bg-zinc-900 rounded-lg flex items-center justify-center text-white font-bold">V</div>
            <span className="font-bold tracking-tight text-lg">VoiceMemo AI</span>
          </div>
          
          <nav className="space-y-1">
            <button 
              onClick={() => setActiveCategory('all')}
              className={`w-full sidebar-item ${activeCategory === 'all' ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <span className="text-lg">📝</span>
              <span className="font-medium">All Notes</span>
            </button>
            <button 
              onClick={() => setActiveCategory('idea')}
              className={`w-full sidebar-item ${activeCategory === 'idea' ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <span className="text-lg">💡</span>
              <span className="font-medium">Ideas</span>
            </button>
            <button 
              onClick={() => setActiveCategory('meeting')}
              className={`w-full sidebar-item ${activeCategory === 'meeting' ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <span className="text-lg">👥</span>
              <span className="font-medium">Meetings</span>
            </button>
            <button 
              onClick={() => setActiveCategory('task')}
              className={`w-full sidebar-item ${activeCategory === 'task' ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <span className="text-lg">✅</span>
              <span className="font-medium">Tasks</span>
            </button>
            <button 
              onClick={() => setActiveCategory('reminder')}
              className={`w-full sidebar-item ${activeCategory === 'reminder' ? 'bg-zinc-100 text-zinc-900' : ''}`}
            >
              <span className="text-lg">📅</span>
              <span className="font-medium">Reminders</span>
            </button>
          </nav>
        </div>

        <div className="p-6">
          <button 
            onClick={() => setShowCreateModal(true)}
            className="w-full py-2 bg-zinc-100 text-zinc-900 rounded-xl font-bold text-sm hover:bg-zinc-200 transition-colors border border-zinc-200"
          >
            + New Note
          </button>
        </div>

        <div className="mt-auto p-6 border-t border-zinc-100">
          <div className="flex items-center gap-3 mb-4">
            <div className={`w-2 h-2 rounded-full ${
              status === 'connected' ? 'bg-green-500 animate-pulse' : 
              status === 'joining' ? 'bg-yellow-500' : 'bg-zinc-300'
            }`} />
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{status}</span>
          </div>
          <button 
            onClick={joined ? leaveCall : joinCall}
            disabled={status === 'joining'}
            className={`w-full py-2.5 rounded-xl font-medium transition-all ${
              joined ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-zinc-900 text-white hover:bg-zinc-800'
            }`}
          >
            {status === 'joining' ? 'Connecting...' : joined ? 'End Session' : 'Start Voice Agent'}
          </button>
        </div>
      </aside>

      {/* Main Workspace */}
      <main className="flex-1 flex flex-col bg-white">
        {/* Header */}
        <header className="h-16 border-b border-zinc-100 flex items-center justify-between px-8">
          <div className="flex-1 max-w-xl">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">🔍</span>
              <input 
                type="text"
                placeholder="Search notes..."
                className="w-full pl-10 pr-4 py-2 bg-zinc-100/50 border-none rounded-xl text-sm focus:ring-2 focus:ring-zinc-200 outline-none transition-all"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  fetchNotes(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">Admin</span>
            <div className="w-8 h-8 rounded-full bg-zinc-200 border border-white shadow-sm" />
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Notes Grid */}
          <section className="flex-1 overflow-y-auto p-8 space-y-6">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-2xl font-bold tracking-tight">Your Notes</h1>
              <span className="text-xs font-medium text-zinc-400 bg-zinc-100 px-2 py-1 rounded-md">{notes.length} Total</span>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {displayNotes.length > 0 ? displayNotes.map((note) => (
                <div 
                  key={note.id} 
                  className={`claude-card group relative overflow-hidden ${typingId === note.id ? 'ring-2 ring-zinc-100' : ''}`}
                >
                  {typingId === note.id && (
                    <div className="absolute top-0 left-0 w-full h-1 bg-zinc-900 animate-[loading_2s_ease-in-out_infinite]" />
                  )}
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex flex-col">
                      {note.title && <h3 className="font-bold text-sm text-zinc-900">{note.title}</h3>}
                      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                        {note.category === 'idea' ? '💡 Idea' : 
                         note.category === 'reminder' ? '📅 Reminder' : 
                         note.category === 'task' ? '✅ Task' : 
                         note.category === 'meeting' ? '👥 Meeting' : '📝 General'}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-300 font-medium italic">
                      {new Date(note.created_at).toLocaleDateString()} {new Date(note.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {note.description && <p className="text-[10px] text-zinc-400 mb-2 italic">{note.description}</p>}
                  
                  {editingNoteId === note.id ? (
                    <div className="space-y-3">
                      <textarea
                        className="w-full p-3 border border-zinc-200 rounded-xl text-sm focus:ring-2 focus:ring-zinc-200 outline-none min-h-[100px]"
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <button 
                          onClick={() => setEditingNoteId(null)}
                          className="text-xs font-medium text-zinc-500 hover:text-zinc-700"
                        >
                          Cancel
                        </button>
                        <button 
                          onClick={() => handleUpdateNote(note.id, editContent)}
                          className="text-xs font-bold text-zinc-900 hover:text-black"
                        >
                          Save Changes
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-zinc-800 leading-relaxed mb-4 whitespace-pre-wrap">
                        {note.content}
                        {typingId === note.id && <span className="inline-block w-1.5 h-4 bg-zinc-400 ml-1 animate-pulse align-middle" />}
                      </p>
                      <div className="flex justify-end gap-4 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={() => {
                            setEditingNoteId(note.id);
                            setEditContent(note.content);
                          }}
                          className="text-xs font-semibold text-zinc-400 hover:text-zinc-900 transition-colors"
                        >
                          Edit
                        </button>
                        <button 
                          onClick={() => handleDeleteNote(note.id)}
                          className="text-xs font-semibold text-zinc-400 hover:text-red-500 transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )) : (
                <div className="col-span-full h-64 flex flex-col items-center justify-center text-zinc-300 border-2 border-dashed border-zinc-100 rounded-3xl">
                  <span className="text-4xl mb-2">🧊</span>
                  <p className="font-medium">No notes found. Start the voice agent to capture ideas.</p>
                </div>
              )}
            </div>
          </section>

          {/* Voice Visualizer Panel (Right) */}
          <aside className="w-80 border-l border-zinc-100 bg-zinc-50/30 flex flex-col items-center justify-center p-8 text-center">
            {joined ? (
              <div className="space-y-8 w-full">
                <div className="relative">
                  <div className="w-32 h-32 bg-zinc-900 rounded-full mx-auto flex items-center justify-center shadow-2xl shadow-zinc-900/20">
                    <div className="w-16 h-1 bg-white/20 rounded-full animate-pulse" />
                  </div>
                  {/* Waveform simulation */}
                  <div className="flex justify-center gap-1 mt-8 h-8">
                    {[1, 2, 3, 4, 5].map(i => (
                      <div 
                        key={i} 
                        className={`w-1 bg-zinc-900 rounded-full animate-bounce`} 
                        style={{ 
                          animationDelay: `${i * 0.1}s`, 
                          height: isClient ? `${Math.floor(Math.random() * 80) + 20}%` : '50%' 
                        }} 
                      />
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="font-bold text-lg">AI Agent Listening</h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">
                    &quot;{(() => {
                      const hour = new Date().getHours();
                      if (hour >= 5 && hour < 12) return 'Good morning, Admin.';
                      if (hour >= 12 && hour < 18) return 'Good afternoon, Admin.';
                      if (hour >= 18 && hour < 22) return 'Good evening, Admin.';
                      return 'Good night, Admin.';
                    })()} How can I help with your notes today?&quot;
                  </p>
                </div>
                <div className="p-4 bg-white border border-zinc-200 rounded-2xl text-left shadow-sm">
                  <div className="flex justify-between items-center mb-3">
                    <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Live Transcript</p>
                    <span className={`w-2 h-2 rounded-full ${isAiSpeaking ? 'bg-blue-500 animate-pulse' : 'bg-green-500'}`} />
                  </div>
                  <p className="text-xs text-zinc-600 leading-relaxed min-h-[60px]">
                    {isAiSpeaking ? (
                      <span className="text-blue-500 font-medium">🎙️ AI is speaking...</span>
                    ) : (
                      transcript || "Listening to Admin..."
                    )}
                    <span className="inline-block w-1 h-3 bg-zinc-300 ml-1 animate-pulse" />
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button className="text-[9px] font-bold text-zinc-400 hover:text-zinc-900">USER VOICE</button>
                    <button className="text-[9px] font-bold text-zinc-900">AI OUTPUT</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="w-20 h-20 bg-zinc-100 rounded-full mx-auto flex items-center justify-center text-3xl">
                  🎙️
                </div>
                <div>
                  <h3 className="font-bold mb-2">Voice Interface</h3>
                  <p className="text-sm text-zinc-400">Click &quot;Start Voice Agent&quot; to begin your session.</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </main>

      {/* Create Note Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-zinc-900/20 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl border border-zinc-100 overflow-hidden">
            <div className="p-6 border-b border-zinc-50 flex justify-between items-center">
              <h2 className="text-xl font-bold tracking-tight">Create Manual Note</h2>
              <button onClick={() => setShowCreateModal(false)} className="text-zinc-400 hover:text-zinc-900 text-xl">×</button>
            </div>
            <form onSubmit={handleCreateNote} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Title</label>
                  <input 
                    type="text" 
                    className="w-full p-2.5 bg-zinc-50 border border-zinc-100 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-100"
                    placeholder="Note title..."
                    value={newNote.title}
                    onChange={e => setNewNote({...newNote, title: e.target.value})}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Category</label>
                  <select 
                    className="w-full p-2.5 bg-zinc-50 border border-zinc-100 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-100"
                    value={newNote.category}
                    onChange={e => setNewNote({...newNote, category: e.target.value})}
                  >
                    <option value="general">📝 General</option>
                    <option value="idea">💡 Idea</option>
                    <option value="task">✅ Task</option>
                    <option value="meeting">👥 Meeting</option>
                    <option value="reminder">📅 Reminder</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Description</label>
                <input 
                  type="text" 
                  className="w-full p-2.5 bg-zinc-50 border border-zinc-100 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-100"
                  placeholder="Short description..."
                  value={newNote.description}
                  onChange={e => setNewNote({...newNote, description: e.target.value})}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Content</label>
                <textarea 
                  className="w-full p-2.5 bg-zinc-50 border border-zinc-100 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-100 min-h-[120px]"
                  placeholder="Start typing your note..."
                  required
                  value={newNote.content}
                  onChange={e => setNewNote({...newNote, content: e.target.value})}
                />
              </div>
              <div className="pt-4 flex gap-3">
                <button 
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-3 text-sm font-bold text-zinc-500 hover:bg-zinc-50 rounded-2xl transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="flex-1 py-3 text-sm font-bold bg-zinc-900 text-white hover:bg-black rounded-2xl shadow-xl shadow-zinc-900/10 transition-all"
                >
                  Create Note
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}