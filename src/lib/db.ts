import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

export interface Note {
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

export interface IDatabase {
  saveNote(note: Partial<Note> & { source?: 'manual' | 'ai' }): Promise<Note>;
  getNotes(limit?: number, category?: string): Promise<Note[]>;
  searchNotes(query: string): Promise<Note[]>;
  deleteNote(id: string): Promise<void>;
  updateNote(id: string, content: string, title?: string): Promise<void>;
  findNoteByKeyword(query: string): Promise<Note | null>;
}

// File-based JSON store — shared across MCP server + Next.js processes
const DATA_DIR = path.resolve(process.cwd(), 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readNotes(): Map<string, Note> {
  ensureDataDir();
  try {
    if (fs.existsSync(NOTES_FILE)) {
      const raw = fs.readFileSync(NOTES_FILE, 'utf-8');
      const arr: Note[] = JSON.parse(raw);
      return new Map(arr.map(n => [n.id, n]));
    }
  } catch (err) {
    console.error('[MOCK_DB] Failed to read notes file, starting fresh:', err);
  }
  return new Map();
}

function writeNotes(notes: Map<string, Note>): void {
  ensureDataDir();
  const arr = Array.from(notes.values());
  fs.writeFileSync(NOTES_FILE, JSON.stringify(arr, null, 2), 'utf-8');
}

class MockDB implements IDatabase {
  async saveNote(note: Partial<Note> & { source?: 'manual' | 'ai' }): Promise<Note> {
    const notes = readNotes();
    const id = note.id || `note_${new Date().toISOString()}_${uuidv4().slice(0, 8)}`;
    const fullNote: Note = {
      id,
      title: note.title || '',
      name: note.name || 'Admin',
      description: note.description || '',
      content: note.content || '',
      category: note.category || 'general',
      tags: note.tags || [],
      created_at: note.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      type: 'note',
      source: note.source || 'manual',
    };
    notes.set(id, fullNote);
    writeNotes(notes);
    console.log(`[MOCK_DB] Saved note: ${id}. Total notes: ${notes.size}`);
    return fullNote;
  }

  async getNotes(limit: number = 10, category?: string): Promise<Note[]> {
    const notes = readNotes();
    let notesList = Array.from(notes.values());
    if (category && category !== 'all') {
      notesList = notesList.filter(n => n.category === category);
    }
    return notesList
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  async searchNotes(query: string): Promise<Note[]> {
    const notes = readNotes();
    const q = query.toLowerCase();
    return Array.from(notes.values())
      .filter(n => n.content.toLowerCase().includes(q) || (n.title && n.title.toLowerCase().includes(q)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async deleteNote(id: string): Promise<void> {
    const notes = readNotes();
    notes.delete(id);
    writeNotes(notes);
    console.log(`[MOCK_DB] Deleted note: ${id}. Remaining: ${notes.size}`);
  }

  async updateNote(id: string, content: string, title?: string): Promise<void> {
    const notes = readNotes();
    const note = notes.get(id);
    if (note) {
      note.content = content;
      if (title !== undefined) note.title = title;
      note.updated_at = new Date().toISOString();
      notes.set(id, note);
      writeNotes(notes);
    }
  }

  async findNoteByKeyword(q: string): Promise<Note | null> {
    const direct = await this.searchNotes(q);
    if (direct.length > 0) return direct[0];

    const tokens = q.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    if (tokens.length === 0) return null;

    const notes = await this.getNotes(100);
    let best: { note: Note; score: number } | null = null;
    for (const n of notes) {
      const hay = `${n.title || ''} ${n.content}`.toLowerCase();
      const score = tokens.filter((t) => hay.includes(t)).length;
      const minHits = Math.min(3, tokens.length);
      if (score >= minHits && (!best || score > best.score)) {
        best = { note: n, score };
      }
    }
    return best?.note ?? null;
  }
}

export const mockDb = new MockDB();
