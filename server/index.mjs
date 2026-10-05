import http from 'node:http';import {readFile,stat} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';import {GET,POST} from './routes.mjs';
import {originMatches} from './origin.mjs';
import {compareCatalogTitles,exportSongs,restoreSongs} from './db.mjs';
const password=process.env.ADMIN_PASSWORD;if(!password||password.length<12||password==='change-this-password-before-running'){console.error('請在 .env 設定至少 12 字元的 ADMIN_PASSWORD。');process.exit(1)}
const sessions=new Map(),attempts=new Map(),root=fileURLToPath(new URL('../dist/',import.meta.url));
const hash=s=>createHash('sha256').update(s).digest();
function reply(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function originOK(req){return originMatches(req.headers,`http://${req.headers.host}${req.url}`)}
function loggedIn(req){const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('pk_session='))?.slice(11);return token&&sessions.has(token)}
async function readBody(req,limit=131072){let size=0,parts=[];for await(const p of req){size+=p.length;if(size>limit)throw Object.assign(Error('資料太大'),{status:413});parts.push(p)}return Buffer.concat(parts)}
setInterval(()=>{for(const [k,v] of attempts)if(v.until<Date.now())attempts.delete(k)},60000).unref();
const server=http.createServer(async(req,res)=>{try{
res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
const u=new URL(req.url,'http://'+req.headers.host);
if(u.pathname==='/admin/backup'){
 if(req.method!=='GET')return reply(res,{error:'不支援此操作'},405);
 if(!loggedIn(req))return reply(res,{error:'請先回首頁點「歌曲管理」並登入，再開此頁。'},401);
 const html=await readFile(new URL('./backup.html',import.meta.url));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
}
if(u.pathname==='/api/backup/compare'){
 if(req.method!=='POST')return reply(res,{error:'不支援此操作'},405);
 if(!loggedIn(req))return reply(res,{error:'請先登入歌曲管理'},401);
 if(!originOK(req))return reply(res,{error:'請求來源錯誤'},403);
 let rows;try{rows=JSON.parse((await readBody(req,10485760)).toString('utf8').replace(/^\uFEFF/,''))}catch(e){if(e.status)throw e;return reply(res,{error:'請選擇 JSON 備份檔'},400)}
 if(!Array.isArray(rows)||!rows.length||rows.length>10000)return reply(res,{error:'備份必須包含 1 到 10000 首歌曲'},400);
 return reply(res,await compareCatalogTitles(rows));
}
if(u.pathname==='/api/backup'){
 if(!loggedIn(req))return reply(res,{error:'請先登入歌曲管理'},401);
 if(req.method==='GET'){res.setHeader('Content-Disposition','attachment; filename="pk-library-backup.json"');return reply(res,await exportSongs())}
 if(req.method==='POST'){
  if(!originOK(req))return reply(res,{error:'請求來源錯誤'},403);
  let payload;try{payload=JSON.parse((await readBody(req,10485760)).toString('utf8').replace(/^\uFEFF/,''))}catch(e){if(e.status)throw e;return reply(res,{error:'請選擇 JSON 備份檔'},400)}
  const rows=Array.isArray(payload)?payload:payload?.rows;
  const result=await restoreSongs(rows,{duplicateMode:Array.isArray(payload)?'add':payload?.duplicateMode});
  return reply(res,{ok:true,...result});
 }
 return reply(res,{error:'不支援此操作'},405);
}
if(u.pathname==='/api/session'&&req.method==='GET')return reply(res,{authenticated:!!loggedIn(req)});
if(u.pathname==='/api/login'&&req.method==='POST'){
 if(!originOK(req))return reply(res,{error:'請求來源錯誤'},403);const key=req.socket.remoteAddress,now=Date.now(),a=attempts.get(key)||{n:0,until:now+900000};if(a.until<now){a.n=0;a.until=now+900000}if(a.n>=10)return reply(res,{error:'嘗試過多，15 分鐘後再試'},429);
 let b;try{b=JSON.parse((await readBody(req)).toString('utf8'))}catch{return reply(res,{error:'資料格式錯誤'},400)}
 if(typeof b?.password!=='string'||!timingSafeEqual(hash(b.password),hash(password))){a.n++;attempts.set(key,a);return reply(res,{error:'管理密碼錯誤'},401)}
 attempts.delete(key);const token=randomBytes(32).toString('hex');sessions.set(token,true);res.setHeader('Set-Cookie',`pk_session=${token}; Path=/; HttpOnly; SameSite=Strict${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);return reply(res,{ok:true});
}
if(u.pathname==='/api/songs'){
 if(!['GET','POST'].includes(req.method))return reply(res,{error:'不支援此操作'},405);
 if(req.method==='POST'){if(!originOK(req))return reply(res,{error:'請求來源錯誤'},403);if(!loggedIn(req))return reply(res,{error:'請輸入管理密碼'},401)}
 const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
 const request=new Request(u,{method:req.method,headers,...(req.method==='POST'?{body:await readBody(req)}:{})});
 const out=await (req.method==='GET'?GET(request):POST(request));res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));return;
}
if(u.pathname.startsWith('/api/'))return reply(res,{error:'找不到 API'},404);
if(!['GET','HEAD'].includes(req.method))return reply(res,{error:'不支援此操作'},405);
let relative;try{relative=decodeURIComponent(u.pathname)}catch{return reply(res,{error:'路徑錯誤'},400)}
let filename=path.resolve(root,'.'+relative);if(filename!==path.resolve(root)&&!filename.startsWith(path.resolve(root)+path.sep))return reply(res,{error:'找不到檔案'},404);
try{if(!(await stat(filename)).isFile())filename=path.join(root,'index.html')}catch{filename=path.join(root,'index.html')}
const bytes=await readFile(filename),type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[path.extname(filename)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':filename.endsWith('index.html')?'no-cache':'public, max-age=31536000, immutable'});res.end(req.method==='HEAD'?undefined:bytes);
}catch(e){console.error('Request failed:',e.message);reply(res,{error:e.status?e.message:'伺服器處理失敗'},e.status||500)}});
server.listen(Number(process.env.PORT)||3000,process.env.HOST||'0.0.0.0',()=>console.log('PK曲庫已啟動：http://localhost:'+(Number(process.env.PORT)||3000)));
