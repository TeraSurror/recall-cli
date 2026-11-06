import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";
import { sessionsDb } from "../config/paths.ts";

export interface SessionInfo {
  id: string;
  title: string;
  profile: string | null;
  createdAt: number;
  updatedAt: number;
  turns: number;
}

let db: Database | null = null;
function open(): Database {
  if (db) return db;
  mkdirSync(dirname(sessionsDb()), { recursive: true });
  db = new Database(sessionsDb(), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, profile TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
    messages TEXT NOT NULL DEFAULT '[]'
  )`);
  return db;
}

export function newSessionId(): string {
  return `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
}

function titleFrom(messages: ModelMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = typeof first?.content === "string" ? first.content : "";
  const line = text.split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "(untitled)";
}

export function saveSession(id: string, messages: ModelMessage[], profile?: string): void {
  if (messages.length === 0) return;
  const now = Date.now();
  const turns = messages.filter((m) => m.role === "user").length;
  open()
    .query(
      `INSERT INTO sessions (id, title, profile, created_at, updated_at, turns, messages) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at,
         turns = excluded.turns, messages = excluded.messages`,
    )
    .run(id, titleFrom(messages), profile ?? null, now, now, turns, JSON.stringify(messages));
}

export function loadSession(id: string): { info: SessionInfo; messages: ModelMessage[] } | null {
  const row = open()
    .query("SELECT id, title, profile, created_at, updated_at, turns, messages FROM sessions WHERE id = ? OR id LIKE ? ORDER BY updated_at DESC LIMIT 1")
    .get(id, `%${id}`) as { id: string; title: string; profile: string | null; created_at: number; updated_at: number; turns: number; messages: string } | null;
  if (!row) return null;
  return {
    info: { id: row.id, title: row.title, profile: row.profile, createdAt: row.created_at, updatedAt: row.updated_at, turns: row.turns },
    messages: JSON.parse(row.messages),
  };
}

export function listSessions(limit = 20): SessionInfo[] {
  return (
    open()
      .query("SELECT id, title, profile, created_at, updated_at, turns FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as { id: string; title: string; profile: string | null; created_at: number; updated_at: number; turns: number }[]
  ).map((r) => ({ id: r.id, title: r.title, profile: r.profile, createdAt: r.created_at, updatedAt: r.updated_at, turns: r.turns }));
}

export function closeSessions(): void {
  db?.close();
  db = null;
}
