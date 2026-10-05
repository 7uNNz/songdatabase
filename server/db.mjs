import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { postgresSQL } from './sql.mjs';
import { youtubeUrl } from './youtube-url.mjs';

const connectionString = process.env.DATABASE_URL;
if (!connectionString && (process.env.REQUIRE_DATABASE_URL === '1' || process.env.RENDER || process.env.RENDER_SERVICE_ID)) {
  throw new Error('請先設定 DATABASE_URL。曲庫不會寫入 Render 的暫存磁碟。');
}
let sqlite, pool;
const schema = `CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
  lyrics TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL,
  youtube_url TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS title_idx ON songs(title);
CREATE INDEX IF NOT EXISTS artist_idx ON songs(artist);
CREATE TABLE IF NOT EXISTS pk_library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;
if (connectionString) {
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 30000 });
  pool.on('error', () => console.error('資料庫連線中斷，下一次請求會重新連線。'));
  await pool.query(schema);
  await pool.query('ALTER TABLE songs ADD COLUMN IF NOT EXISTS youtube_url TEXT; ALTER TABLE songs ADD COLUMN IF NOT EXISTS note TEXT;');
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const filename = path.resolve(process.env.DB_PATH || 'data/songs.sqlite');
  mkdirSync(path.dirname(filename), { recursive: true });
  sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  sqlite.exec(schema);
  const columns = sqlite.prepare('PRAGMA table_info(songs)').all();
  for (const c of ['youtube_url', 'note']) if (!columns.some(x => x.name === c)) sqlite.exec(`ALTER TABLE songs ADD COLUMN ${c} TEXT`);
}
function normalize(row) {
  if (!row) return null;
  for (const key of ['created_at', 'n', 'total', 'artists', 'ready'])
    if (typeof row[key] === 'string') row[key] = Number(row[key]);
  return row;
}
async function query(sql, values = [], client = pool) {
  if (pool) {
    const result = await client.query(postgresSQL(sql), values);
    return { rows: result.rows.map(normalize), changes: result.rowCount };
  }
  const statement = sqlite.prepare(sql);
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { rows: statement.all(...values).map(normalize) };
  const result = statement.run(...values);
  return { rows: [], changes: Number(result.changes) };
}
async function transaction(fn) {
  const client = pool ? await pool.connect() : null;
  try {
    if (client) await client.query('BEGIN'); else sqlite.exec('BEGIN IMMEDIATE');
    const out = await fn(client);
    if (client) await client.query('COMMIT'); else sqlite.exec('COMMIT');
    return out;
  } catch (error) {
    if (client) await client.query('ROLLBACK'); else sqlite.exec('ROLLBACK');
    throw error;
  } finally { client?.release(); }
}
const insertSQL = 'INSERT INTO songs(id,title,artist,lyrics,created_at,youtube_url,note) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING';
const valuesOf = r => [r.id, r.title, r.artist, r.lyrics || '', Number(r.created_at) || Date.now(), r.youtube_url ?? null, r.note ?? null];
// Seed exactly once. Restarts never overwrite edits or reintroduce deleted songs.
await transaction(async client => {
  if (client) await client.query("SELECT pg_advisory_xact_lock(718264)");
  const meta = await query('SELECT value FROM pk_library_meta WHERE key=?', ['initialized'], client);
  if (meta.rows.length) return;
  const existing = await query('SELECT count(*) as n FROM songs', [], client);
  // A new cloud database stays empty until a current backup is imported.
  // Seeding an old repository snapshot here could reintroduce deleted songs.
  if (!pool && !existing.rows[0].n) {
    const rows = JSON.parse(readFileSync(new URL('../data/songs.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
    for (const row of rows) await query(insertSQL, valuesOf(row), client);
  }
  await query('INSERT INTO pk_library_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', ['initialized', '1'], client);
});
function prepare(sql) {
  let values = [];
  return {
    bind(...args) { values = args; return this; },
    async first() { return (await query(sql, values)).rows[0] || null; },
    async all() { return { results: (await query(sql, values)).rows }; },
    async run() { return query(sql, values); }
  };
}
export const env = { DB: { prepare } };
export async function exportSongs() { return (await query('SELECT * FROM songs ORDER BY created_at DESC,id ASC')).rows; }
export async function restoreSongs(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw Object.assign(new Error('備份必須包含 1 到 10000 首歌曲'), { status: 400 });
  const ids = new Set();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 200 || ids.has(r.id)
      || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 150
      || typeof r.artist !== 'string' || !r.artist.trim() || r.artist.length > 150
      || typeof r.lyrics !== 'string' || r.lyrics.length > 50000
      || (r.youtube_url != null && (typeof r.youtube_url !== 'string' || r.youtube_url.length > 2048 || (r.youtube_url.trim() && !youtubeUrl(r.youtube_url))))
      || (r.note != null && (typeof r.note !== 'string' || r.note.length > 50000))
      || (r.created_at != null && !Number.isSafeInteger(Number(r.created_at))))
      throw Object.assign(new Error('備份資料格式不正確，尚未寫入任何資料'), { status: 400 });
    ids.add(r.id);
  }
  return transaction(async client => {
    for (const r of rows) await query(`INSERT INTO songs(id,title,artist,lyrics,created_at,youtube_url,note) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
      lyrics=CASE WHEN length(trim(songs.lyrics))=0 THEN excluded.lyrics ELSE songs.lyrics END,
      youtube_url=CASE WHEN songs.youtube_url IS NULL OR songs.youtube_url='' THEN excluded.youtube_url ELSE songs.youtube_url END,
      note=CASE WHEN songs.note IS NULL OR songs.note='' THEN excluded.note ELSE songs.note END`, valuesOf(r), client);
    return rows.length;
  });
}
export async function closeDatabase() { if (pool) await pool.end(); else sqlite.close(); }
