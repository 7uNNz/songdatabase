import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
// Strictly undo UTF-8 bytes mistakenly decoded as Latin-1. Never guess or drop bytes.
export function undoLatin1UTF8(text) {
  if (typeof text !== 'string' || !text || [...text].some(c => c.codePointAt(0) > 255)) return text;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from([...text], c => c.charCodeAt(0))); }
  catch { return text; }
}
export function songTitleKey(text) {
  return undoLatin1UTF8(typeof text === 'string' ? text : '')
    .normalize('NFC').trim().toLocaleLowerCase('zh-Hant');
}
export async function compareCatalogTitles(rows) {
  const catalog = (await query('SELECT id,title,artist FROM songs')).rows;
  const byTitle = new Map();
  for (const song of catalog) {
    const key = songTitleKey(song.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(song);
  }
  const matches = [];
  for (const [index, row] of rows.entries()) {
    if (typeof row?.title !== 'string' || !row.title.trim()) continue;
    const key = songTitleKey(row.title);
    const existing = byTitle.get(key) || [];
    if (existing.length) matches.push({ index, title: row.title.trim(), incomingArtist: row.artist || '', existing: existing.map(song => ({ id: song.id, artist: song.artist })) });
  }
  return { matches };
}
export async function findDuplicateCatalogTitles() {
  const songs = (await query('SELECT id,title,artist FROM songs ORDER BY created_at ASC,id ASC')).rows;
  const groups = new Map();
  for (const song of songs) {
    const key = songTitleKey(song.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(song);
  }
  return [...groups.values()].filter(group => group.length > 1)
    .map(songs => ({ title: songs[0].title, songs }))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
}
export async function deleteDuplicateCatalogSongs(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
    throw Object.assign(new Error('請選擇要刪除的歌曲'), { status: 400 });
  return transaction(async client => {
    const songs = (await query('SELECT id,title FROM songs', [], client)).rows;
    const groups = new Map();
    for (const song of songs) {
      const key = songTitleKey(song.title);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(song.id);
    }
    const duplicateIds = new Set([...groups.values()].filter(group => group.length > 1).flat());
    if (ids.some(id => !duplicateIds.has(id)))
      throw Object.assign(new Error('曲庫資料已變更，請重新掃描後再刪除'), { status: 409 });
    for (const id of ids) await query('DELETE FROM songs WHERE id=?', [id], client);
    return { deleted: ids.length };
  });
}
function mergeRestoredText(current, incoming) {
  if (!current?.trim()) return incoming;
  // Only replace nonblank text if the incoming backup exactly proves the repair.
  return undoLatin1UTF8(current) === incoming ? incoming : current;
}
export async function restoreSongs(rows, { duplicateMode = 'add', artistMerges = [], distinctIndexes = [], skipIndexes = [] } = {}) {
  if (!['add', 'merge'].includes(duplicateMode)) throw Object.assign(new Error('重複處理方式不正確'), { status: 400 });
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
  if (![artistMerges, distinctIndexes, skipIndexes].every(Array.isArray)
    || [...distinctIndexes, ...skipIndexes].some(i => !Number.isInteger(i) || i < 0 || i >= rows.length)
    || artistMerges.some(x => !x || !Number.isInteger(x.index) || x.index < 0 || x.index >= rows.length || typeof x.targetId !== 'string'))
    throw Object.assign(new Error('比對選擇資料格式不正確，請重新比對'), { status: 400 });
  const mergeTargets = new Map(artistMerges.map(x => [x.index, x.targetId]));
  const distinct = new Set(distinctIndexes), skipped = new Set(skipIndexes);
  return transaction(async client => {
    const catalog = (await query('SELECT * FROM songs', [], client)).rows;
    const byId = new Map(catalog.map(song => [song.id, song]));
    const byTitle = new Map();
    for (const song of catalog) {
      const key = songTitleKey(song.title);
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(song);
    }
    let addedCount = 0, mergedCount = 0, alreadyPresentCount = 0, skippedCount = 0;
    for (const [index, r] of rows.entries()) {
      if (skipped.has(index)) { skippedCount++; continue; }
      if (mergeTargets.has(index)) {
        const target = byId.get(mergeTargets.get(index));
        if (!target || songTitleKey(target.title) !== songTitleKey(r.title))
          throw Object.assign(new Error('曲庫歌曲已變更，請重新比對後再匯入'), { status: 409 });
        const parts = text => text.split(/[/／、,，&＆+＋]/u).map(x => x.trim()).filter(Boolean);
        const currentArtists = parts(target.artist || '');
        const newArtists = parts(r.artist || '').filter(name => !currentArtists.some(old => songTitleKey(old) === songTitleKey(name)));
        const artist = newArtists.length ? [...currentArtists, ...newArtists].join(' / ') : target.artist;
        const lyrics = mergeRestoredText(target.lyrics, r.lyrics);
        const note = mergeRestoredText(target.note, r.note);
        const youtube_url = target.youtube_url?.trim() ? target.youtube_url : r.youtube_url;
        await query('UPDATE songs SET artist=?,lyrics=?,note=?,youtube_url=? WHERE id=?', [artist, lyrics, note, youtube_url, target.id], client);
        Object.assign(target, { artist, lyrics, note, youtube_url });
        mergedCount++;
        continue;
      }
      if (distinct.has(index)) {
        const distinctSong = { ...r, id: byId.has(r.id) ? randomUUID() : r.id };
        await query('INSERT INTO songs(id,title,artist,lyrics,created_at,youtube_url,note) VALUES(?,?,?,?,?,?,?)', valuesOf(distinctSong), client);
        addedCount++;
        byId.set(distinctSong.id, distinctSong);
        continue;
      }
      const matches = duplicateMode === 'merge' ? (byTitle.get(songTitleKey(r.title)) || []) : [];
      const sameId = byId.has(r.id);
      const existing = byId.get(r.id) || matches.find(song => songTitleKey(song.artist) === songTitleKey(r.artist)) || matches[0];
      const mergedSong = existing ? {
        ...existing,
        title: mergeRestoredText(existing.title, r.title),
        artist: mergeRestoredText(existing.artist, r.artist),
        lyrics: mergeRestoredText(existing.lyrics, r.lyrics),
        note: mergeRestoredText(existing.note, r.note),
        youtube_url: existing.youtube_url?.trim() ? existing.youtube_url : r.youtube_url
      } : r;
      await query(`INSERT INTO songs(id,title,artist,lyrics,created_at,youtube_url,note) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,
        lyrics=excluded.lyrics,youtube_url=excluded.youtube_url,note=excluded.note`, valuesOf(mergedSong), client);
      if (existing) {
        byId.set(mergedSong.id, mergedSong);
        if (matches.length && existing.id !== r.id) mergedCount++;
        else if (sameId) alreadyPresentCount++;
      } else {
        addedCount++;
        byId.set(mergedSong.id, mergedSong);
        const key = songTitleKey(mergedSong.title);
        if (!byTitle.has(key)) byTitle.set(key, []);
        byTitle.get(key).push(mergedSong);
      }
    }
    return { processed: rows.length, added: addedCount, merged: mergedCount, alreadyPresent: alreadyPresentCount, skipped: skippedCount };
  });
}
export async function closeDatabase() { if (pool) await pool.end(); else sqlite.close(); }
