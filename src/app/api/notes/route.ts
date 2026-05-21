import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db-provider';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    const category = searchParams.get('category');
    
    const db = getDb();
    let notes;

    if (q) {
      notes = await db.searchNotes(q);
    } else {
      notes = await db.getNotes(50, category || 'all');
    }
    
    return NextResponse.json(notes);
  } catch (error: any) {
    console.error('API Error in GET /api/notes:', error);
    return NextResponse.json([], { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = getDb();
    const note = await db.saveNote(body);
    return NextResponse.json(note);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { id, content } = await req.json();
    const db = getDb();
    await db.updateNote(id, content);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) throw new Error('ID required');

    const db = getDb();
    await db.deleteNote(id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
