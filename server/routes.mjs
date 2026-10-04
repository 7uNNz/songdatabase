import { env } from "./db.mjs";
import { youtubeUrl } from "./youtube-url.mjs";
export const dynamic = "force-dynamic";
const reply = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export async function GET(req) {
    const u = new URL(req.url), id = u.searchParams.get("id");
    if (id) {
        const song = await env.DB.prepare("SELECT * FROM songs WHERE id=?").bind(id).first();
        return song ? reply(song) : reply({ error: "找不到歌曲" }, 404);
    }
    const q = (u.searchParams.get("q") || "").slice(0, 100), filter = u.searchParams.get("filter") || "all", page = Math.max(0, Math.min(100000, Math.floor(Number(u.searchParams.get("page")) || 0)));
    const artist = (u.searchParams.get("artist") || "").slice(0, 150);
    const members = (credit) => [...new Set(credit.replace(/^PK主題[：:]\s*/, " ").split(/[/／、,，&＆+＋]/u).map(name => name.trim()).filter(Boolean))];
    const catalog = await env.DB.prepare("SELECT id,artist FROM songs").all();
    const artistCounts = new Map();
    for (const song of catalog.results) {
        for (const name of members(song.artist))
            artistCounts.set(name, (artistCounts.get(name) || 0) + 1);
    }
    const artists = [...artistCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hant"));
    const term = '%' + q.replace(/[!%_]/g, c => '!' + c) + '%';
    let where = " WHERE (title LIKE ? ESCAPE '!' OR artist LIKE ? ESCAPE '!')";
    const params = [term, term];
    if (artist) {
        const ids = catalog.results.filter(song => members(song.artist).includes(artist)).map(song => song.id);
        where += " AND id IN (SELECT value FROM json_each(?))";
        params.push(JSON.stringify(ids));
    }
    if (filter === "lyrics")
        where += " AND length(trim(lyrics))>0";
    if (filter === "favorites") {
        let ids;
        try {
            ids = JSON.parse(u.searchParams.get("ids") || "[]");
        }
        catch {
            ids = [];
        }
        if (!Array.isArray(ids) || ids.length > 5000 || ids.some(x => typeof x !== "string"))
            return reply({ error: "收藏資料格式錯誤" }, 400);
        where += " AND id IN (SELECT value FROM json_each(?))";
        params.push(JSON.stringify(ids));
    }
    const count = await env.DB.prepare("SELECT count(*) as n FROM songs" + where).bind(...params).first();
    const list = await env.DB.prepare("SELECT id,title,artist,youtube_url,length(trim(lyrics))>0 as hasLyrics FROM songs" + where + " ORDER BY created_at DESC,id ASC LIMIT 24 OFFSET ?").bind(...params, page * 24).all();
    const stats = await env.DB.prepare("SELECT count(*) as total,count(distinct artist) as artists,sum(length(trim(lyrics))>0) as ready FROM songs").first();
    return reply({ songs: list.results, total: count?.n || 0, stats: { ...stats, artists: artists.length }, artists });
}
export async function POST(req) {
    if (req.headers.get("Origin") !== new URL(req.url).origin)
        return reply({ error: "不允許的請求來源" }, 403);
    // The platform enforces the owner-private access boundary for this site.
    let b;
    try {
        b = await req.json();
    }
    catch {
        return reply({ error: "資料格式錯誤" }, 400);
    }
    if (!b || typeof b !== "object")
        return reply({ error: "資料格式錯誤" }, 400);
    if (b.action === "delete") {
        if (typeof b.id !== "string")
            return reply({ error: "缺少歌曲 ID" }, 400);
        await env.DB.prepare("DELETE FROM songs WHERE id=?").bind(b.id).run();
        return reply({ ok: true });
    }
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 150 || typeof b.artist !== "string" || !b.artist.trim() || b.artist.length > 150 || typeof b.lyrics !== "string" || b.lyrics.length > 500)
        return reply({ error: "請填寫歌名、歌手；歌詞最多 500 字" }, 400);
    const hasUrl = Object.prototype.hasOwnProperty.call(b, "youtube_url");
    if (hasUrl && (typeof b.youtube_url !== "string" || (b.youtube_url.trim() && !youtubeUrl(b.youtube_url))))
        return reply({ error: "請填入有效的 YouTube 影片網址" }, 400);
    const url = hasUrl ? youtubeUrl(b.youtube_url) : null;
    const hasNote = Object.prototype.hasOwnProperty.call(b, "note");
    if (hasNote && (typeof b.note !== "string" || b.note.length > 500))
        return reply({ error: "備註最多 500 字" }, 400);
    const note = hasNote ? b.note.trim() : null;
    const id = b.id || crypto.randomUUID();
    if (b.id) {
        await env.DB.prepare("UPDATE songs SET title=?,artist=?,lyrics=?,youtube_url=CASE WHEN ? THEN ? ELSE youtube_url END,note=CASE WHEN ? THEN ? ELSE note END WHERE id=?").bind(b.title.trim(), b.artist.trim(), b.lyrics, hasUrl ? 1 : 0, url, hasNote ? 1 : 0, note, id).run();
    }
    else {
        await env.DB.prepare("INSERT INTO songs(id,title,artist,lyrics,created_at,youtube_url,note) VALUES(?,?,?,?,?,?,?)").bind(id, b.title.trim(), b.artist.trim(), b.lyrics, Date.now(), url, note).run();
    }
    return reply({ ok: true, id });
}
