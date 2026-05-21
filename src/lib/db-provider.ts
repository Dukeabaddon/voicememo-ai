import { IDatabase, mockDb, Note } from './db';
import { getCouchbase } from './couchbase';
import * as couchbase from 'couchbase';

class CapellaDB implements IDatabase {
  async saveNote(note: Partial<Note> & { source?: 'manual' | 'ai' }): Promise<Note> {
    const { collection } = await getCouchbase();
    const id = note.id || `note_${new Date().toISOString()}_${Math.random().toString(36).slice(2, 10)}`;
    const doc = {
      id,
      title: note.title || '',
      name: note.name || 'Admin',
      description: note.description || '',
      content: note.content,
      category: note.category || 'general',
      tags: note.tags || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      type: 'note',
      source: note.source || 'manual'
    };
    await collection.upsert(id, doc);
    return doc as any;
  }

  async getNotes(limit: number = 10, category?: string): Promise<Note[]> {
    const { cluster, bucket, scope, collection } = await getCouchbase();
    let query = `SELECT * FROM \`${bucket.name}\`.\`${scope.name}\`.\`${collection.name}\` WHERE type = 'note'`;
    const params: any[] = [];
    
    if (category && category !== 'all') {
      query += ` AND category = $1`;
      params.push(category);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await cluster.query(query, { parameters: params });
    return result.rows.map((row: any) => row[collection.name]);
  }

  async searchNotes(q: string): Promise<Note[]> {
    const { cluster, bucket, scope, collection } = await getCouchbase();
    const query = `SELECT * FROM \`${bucket.name}\`.\`${scope.name}\`.\`${collection.name}\` WHERE type = 'note' AND (content LIKE $1 OR title LIKE $1) ORDER BY created_at DESC`;
    const result = await cluster.query(query, { parameters: [`%${q}%`] });
    return result.rows.map((row: any) => row[collection.name]);
  }

  async deleteNote(id: string): Promise<void> {
    const { collection } = await getCouchbase();
    await collection.remove(id);
  }

  async updateNote(id: string, content: string, title?: string): Promise<void> {
    const { collection } = await getCouchbase();
    const specs = [
      couchbase.MutateInSpec.upsert('content', content),
      couchbase.MutateInSpec.upsert('updated_at', new Date().toISOString()),
    ];
    if (title !== undefined) {
      specs.push(couchbase.MutateInSpec.upsert('title', title));
    }
    await collection.mutateIn(id, specs);
  }

  async findNoteByKeyword(q: string): Promise<Note | null> {
    const notes = await this.searchNotes(q);
    return notes.length > 0 ? notes[0] : null;
  }
}

const capellaDb = new CapellaDB();

export const getDb = (): IDatabase => {
  // Ensure we check the environment variable correctly
  return process.env.USE_MOCK_DB === 'true' ? mockDb : capellaDb;
};
