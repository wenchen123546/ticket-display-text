/* ==========================================
 * 伺服器 (index.js) - v17.2 Optimized
 * ========================================== */
require('dotenv').config();
const { Server } = require("http"), express = require("express"), Redis = require("ioredis"), sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid'), bcrypt = require('bcrypt'), line = require('@line/bot-sdk'), fs = require("fs"), path = require("path");
const { PORT=3000, UPSTASH_REDIS_URL: R_URL, ADMIN_TOKEN: ADM_TOK, LINE_ACCESS_TOKEN: L_TOK, LINE_CHANNEL_SECRET: L_SEC, ALLOWED_ORIGINS } = process.env;
if (!ADM_TOK || !R_URL) { console.error("❌ Missing ENV"); process.exit(1); }

// --- Consts & Keys ---
const B_HOURS = { s: 8, e: 22, on: false }, FLUSH_MS = 5000, DB_Q = [];
const ROLES = { OPERATOR: { level: 1, can: ['call','pass','recall','issue','appointment'] }, MANAGER: { level: 2, can: ['call','pass','recall','issue','appointment','stats','settings','users'] }, ADMIN: { level: 9, can: ['*'] } };
const K = { CUR:'callsys:number', ISS:'callsys:issued', MODE:'callsys:mode', PASS:'callsys:passed', FEAT:'callsys:featured', LOG:'callsys:admin-log', USR:'callsys:users', NIC:'callsys:nicknames', U_ROL:'callsys:user_roles', SESS:'callsys:session:', HIS:'callsys:stats:history', HR:'callsys:stats:hourly:', ROL:'callsys:config:roles', L:{ SUB:'callsys:line:notify:', USR:'callsys:line:user:', PWD:'callsys:line:unlock_pwd', ADM:'callsys:line:admin_session:', CTX:'callsys:line:context:', ACT:'callsys:line:active_subs_set', TOK:'callsys:line:cfg:token', SEC:'callsys:line:cfg:secret' } };

// --- Setup ---
const app = express(), server = Server(app), redis = new Redis(R_URL, { tls: { rejectUnauthorized: false }, retryStrategy: t=>Math.min(t*50, 2000) });
const io = require("socket.io")(server, { cors: { origin: ALLOWED_ORIGINS?ALLOWED_ORIGINS.split(','):["http://localhost:3000"], methods: ["GET","POST"], credentials: true }, pingTimeout: 60000 });
const db = new sqlite3.Database(path.join(__dirname, 'callsys.db')), dbQ = (m,s,p=[])=>new Promise((r,j)=>db[m](s,p,(e,d)=>e?j(e):r(m==='run'?this:d)));
const [run, all, get] = ['run','all','get'].map(m=>(s,p)=>dbQ(m,s,p));
app.use(require('helmet')({contentSecurityPolicy:false}), express.static(path.join(__dirname,"public")), express.json()); app.set('trust proxy', 1);

let lineClient, bCastT, cacheWait=0, lastWait=0;
const initLine = async () => { const [t, s] = await redis.mget(K.L.TOK, K.L.SEC); try { if((t||L_TOK) && (s||L_SEC)) lineClient = new line.Client({ channelAccessToken: t||L_TOK, channelSecret: s||L_SEC }); } catch(e){} };
try { if(!fs.existsSync('user_logs')) fs.mkdirSync('user_logs'); } catch{}

// --- Helpers ---
const nowTW = () => { const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit'}).formatToParts(new Date()); return { d: `${p[0].value}-${p[2].value}-${p[4].value}`, h: parseInt(p[6].value)%24 }; };
const log = async (n, m) => { const t = new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei'}); await redis.lpush(K.LOG, `[${t}] [${n}] ${m}`); await redis.ltrim(K.LOG, 0, 99); io.to("admin").emit("newAdminLog", `[${t}] [${n}] ${m}`); };
const bc = async () => { clearTimeout(bCastT); bCastT = setTimeout(async()=>{ const [c,i] = (await redis.mget(K.CUR, K.ISS)).map(v=>parseInt(v)||0); if(i<c) await redis.set(K.ISS, c); io.emit("update", c); io.emit("updateQueue", {current:c, issued:Math.max(c,i)}); io.emit("updateWaitTime", await waitTime()); }, 50); };
const bcAppt = async () => io.to("admin").emit("updateAppointments", await all("SELECT * FROM appointments WHERE status='pending' ORDER BY scheduled_time ASC"));
const waitTime = async (force) => { if(!force && Date.now()-lastWait<6e4) return cacheWait; const r=await all(`SELECT timestamp FROM history WHERE action='call' ORDER BY timestamp DESC LIMIT 20`); return (lastWait=Date.now(), cacheWait = r.length<2 ? 0 : Math.ceil((r.reduce((a,b,i,arr)=>i<arr.length-1?a+(b.timestamp-arr[i+1].timestamp):a,0)/(r.length-1)/60000)*10)/10); };
const checkLine = async (c) => { if(!lineClient) return; const t=c+5, [msg5, msg0, u5, u0] = await Promise.all([redis.get('callsys:line:msg:approach'), redis.get('callsys:line:msg:arrival'), redis.smembers(K.L.SUB+t), redis.smembers(K.L.SUB+c)]); const s=(ids,txt)=>ids.length&&lineClient.multicast(ids.splice(0,500),[{type:'text',text:txt}]).catch(()=>{}); if(u5.length) s(u5, (msg5||'🔔 快到了').replace('{current}',c).replace('{target}',t).replace('{diff}',5)); if(u0.length) { s(u0, (msg0||'🎉 到您了').replace('{current}',c)); redis.multi().del(K.L.SUB+c).srem(K.L.ACT,c).exec(); } };

// --- Middleware ---
const H = fn => async(req,res,next) => { try{ const r=await fn(req,res); if(r!==false) res.json(r||{success:true}); }catch(e){ res.status(500).json({error:e.message}); } };
const auth = async(req,res,next) => { try { const t=req.headers.cookie?.match(/token=([^;]+)/)?.[1], u=t&&JSON.parse(await redis.get(K.SESS+t)); if(!u) throw 0; req.user=u; await redis.expire(K.SESS+t, 28800); next(); } catch{ res.status(403).json({error:"權限/Session失效"}); } };
const perm = (act) => async(req,res,next) => { const r = (JSON.parse(await redis.get(K.ROL))||ROLES)[req.user.role==='super'?'ADMIN':(req.user.userRole||'OPERATOR')]; if(r.level>=9 || r.can.includes(act) || r.can.includes('*')) return next(); res.status(403).json({error:"權限不足"}); };

// --- Routes: Auth & Ticket ---
app.post("/login", require('express-rate-limit')({windowMs:9e5,max:100}), H(async (req, res) => {
    const { username: u, password: p } = req.body, safe = (ADM_TOK||"").trim();
    let ok = (u==='superadmin' && (p||"").trim()===safe);
    if(!ok && await redis.hexists(K.USR, u)) ok = await bcrypt.compare(p, await redis.hget(K.USR, u));
    if(!ok) throw new Error("帳號或密碼錯誤");
    const tok = uuidv4(), nick = await redis.hget(K.NIC, u)||u, role = u==='superadmin'?'super':'normal', uRole = u==='superadmin'?'ADMIN':(await redis.hget(K.U_ROL, u)||'OPERATOR');
    await redis.set(K.SESS+tok, JSON.stringify({username:u, role, userRole:uRole, nickname:nick}), "EX", 28800);
    res.setHeader('Set-Cookie', [`token=${tok}; HttpOnly; Path=/; Max-Age=28800; SameSite=Strict`]);
    return { success: true, role, userRole: uRole, username: u, nickname: nick };
}));

app.post("/api/ticket/take", H(async () => {
    if(await redis.get(K.MODE)==='input') throw new Error("手動模式");
    if(B_HOURS.on) { const h=new Date().getHours(); if(h<B_HOURS.s||h>=B_HOURS.e) throw new Error("非營業時間"); }
    const {d,h} = nowTW(), t = await redis.incr(K.ISS);
    await redis.hincrby(K.HR+d, `${h}_i`, 1); await redis.expire(K.HR+d, 172800);
    DB_Q.push({d, ts:Date.now(), n:t, act:'online_take', op:'User', w:await waitTime()}); await bc(); return { ticket: t };
}));

// --- Routes: Control & Logic ---
async function ctl(type, {body:{number:n, direction:dir}, user}) {
    if(n!==undefined && (isNaN(n)||n<0||n>9999)) return {error:"非法數值"};
    const {d, h} = nowTW(), cur = parseInt(await redis.get(K.CUR))||0;
    let iss = parseInt(await redis.get(K.ISS))||0, newN=0, msg='';
    if(['call','issue'].includes(type) && B_HOURS.on && (new Date().getHours()<B_HOURS.s || new Date().getHours()>=B_HOURS.e)) return {error:"非營業時間"};

    if(type === 'call') {
        const appt = dir==='next' && await get("SELECT number FROM appointments WHERE status='pending' AND scheduled_time<=? ORDER BY scheduled_time ASC LIMIT 1", [Date.now()]);
        if(appt) { newN=appt.number; await run("UPDATE appointments SET status='called' WHERE number=?",[newN]); msg=`🔔 呼叫預約 ${newN}`; bcAppt(); }
        else {
            if(dir==='next') { if((newN = await redis.safeNextNumber(K.CUR, K.ISS)) === -1) return {error:"已無等待"}; msg=`號碼增加為 ${newN}`; }
            else { newN = await redis.decrIfPositive(K.CUR); msg=`號碼回退為 ${newN}`; }
        }
        await redis.set(K.CUR, newN); checkLine(newN);
    } else if(type === 'issue') {
        if(dir==='next') { newN = await redis.incr(K.ISS); msg=`手動發號 ${newN}`; await redis.hincrby(K.HR+d, `${h}_i`, 1); }
        else if(iss>cur) { newN = await redis.decr(K.ISS); msg=`手動回退 ${newN}`; await redis.hincrby(K.HR+d, `${h}_i`, -1); }
        else return {error:"錯誤"};
        await redis.expire(K.HR+d, 172800);
    } else if(type.startsWith('set')) {
        newN = parseInt(n);
        if(type==='set_issue') { if(newN===0) return reset(user.nickname); const diff=newN-iss; if(diff) await redis.hincrby(K.HR+d, `${h}_i`, diff); await redis.set(K.ISS, newN); msg=`修正發號 ${newN}`; }
        else { await redis.mset(K.CUR, newN, ...(newN>iss?[K.ISS,newN]:[])); msg=`設定叫號 ${newN}`; checkLine(newN); }
    }
    if(msg) { log(user.nickname, msg); DB_Q.push({d, ts:Date.now(), n:newN||cur, act:type, op:user.nickname, w:await waitTime()}); }
    await bc(); return { number: newN };
}
async function reset(by) { await redis.mset(K.CUR,0,K.ISS,0); await redis.del(K.PASS, K.L.ACT); await run("UPDATE appointments SET status='cancelled' WHERE status='pending'"); log(by, "💥 全域重置"); cacheWait=0; await bc(); bcAppt(); io.emit("updatePassed",[]); return {}; }
['call','issue','set-call','set-issue'].forEach(c => app.post(`/api/control/${c}`, auth, perm(c.startsWith('set')?'settings':c.split('-')[0]), H(async r => { const res=await ctl(c.replace('-','_'),r); if(res.error) throw new Error(res.error); return res; })));

app.post("/api/control/pass-current", auth, perm('pass'), H(async r => {
    const c = parseInt(await redis.get(K.CUR))||0; if(!c) throw new Error("無叫號");
    await redis.zadd(K.PASS, c, c); await redis.hincrby(K.HR+nowTW().d, `${nowTW().h}_p`, 1);
    DB_Q.push({d:nowTW().d, ts:Date.now(), n:c, act:'pass', op:r.user.nickname, w:await waitTime()});
    const next = await redis.safeNextNumber(K.CUR, K.ISS)===-1 ? c : await redis.get(K.CUR);
    checkLine(next); await bc(); io.emit("updatePassed", (await redis.zrange(K.PASS,0,-1)).map(Number)); return { next };
}));
app.post("/api/control/recall-passed", auth, perm('recall'), H(async r => {
    await redis.zrem(K.PASS, r.body.number); await redis.set(K.CUR, r.body.number); await redis.hincrby(K.HR+nowTW().d, `${nowTW().h}_p`, -1);
    log(r.user.nickname, `↩️ 重呼 ${r.body.number}`); await bc(); io.emit("updatePassed", (await redis.zrange(K.PASS,0,-1)).map(Number));
}));
const passMod = async(r, op) => { const n=parseInt(r.body.number); if(n>0){ await redis[op](K.PASS,n,n); await redis.hincrby(K.HR+nowTW().d, `${nowTW().h}_p`, op==='zadd'?1:-1); io.emit("updatePassed", (await redis.zrange(K.PASS,0,-1)).map(Number)); log(r.user.nickname, `${op==='zadd'?'➕ 手動':'🗑️ 移除'}過號 ${n}`); }};
app.post("/api/passed/add", auth, perm('pass'), H(r=>passMod(r,'zadd'))); app.post("/api/passed/remove", auth, perm('pass'), H(r=>passMod(r,'zrem')));

// --- Routes: Admin / Stats / Settings ---
app.post("/api/admin/users", auth, perm('users'), H(async () => ({ users: await Promise.all([{username:'superadmin',nickname:await redis.hget(K.NIC,'superadmin')||'Super',role:'ADMIN'}, ...(await redis.hkeys(K.USR)).map(x=>({username:x,nickname:null,role:null}))].map(async u=>{ if(u.username!=='superadmin'){u.nickname=await redis.hget(K.NIC,u.username)||u.username; u.role=await redis.hget(K.U_ROL,u.username)||'OPERATOR';} return u; })) })));
app.post("/api/admin/add-user", auth, perm('users'), H(async r=>{ if(await redis.hexists(K.USR, r.body.newUsername)) throw 0; await redis.hset(K.USR, r.body.newUsername, await bcrypt.hash(r.body.newPassword,10)); await redis.hset(K.NIC, r.body.newUsername, r.body.newNickname); await redis.hset(K.U_ROL, r.body.newUsername, r.body.newRole||'OPERATOR'); }));
app.post("/api/admin/del-user", auth, perm('users'), H(async r=>{ if(r.body.delUsername==='superadmin') throw 0; await redis.del([K.USR, K.NIC, K.U_ROL].map(k=>({key:k, field:r.body.delUsername}))); await redis.hdel(K.USR, r.body.delUsername); await redis.hdel(K.NIC, r.body.delUsername); await redis.hdel(K.U_ROL, r.body.delUsername); }));
app.post("/api/admin/set-nickname", auth, H(async r=>{ if(r.user.role!=='super'&&r.user.username!==r.body.targetUsername) throw 0; await redis.hset(K.NIC, r.body.targetUsername, r.body.nickname); }));
app.post("/api/admin/set-role", auth, perm('users'), H(async r=>{ if(r.user.role!=='super') throw 0; await redis.hset(K.U_ROL, r.body.targetUsername, r.body.newRole); }));

app.post("/api/admin/stats", auth, perm('stats'), H(async () => {
    const {d,h} = nowTW(), hD = await redis.hgetall(K.HR+d), cts = new Array(24).fill(0); let tot=0;
    if(hD) for(let i=0;i<24;i++) { let n=Math.max(0, (parseInt(hD[`${i}_i`]||0) - parseInt(hD[`${i}_p`]||0))); cts[i]=n; tot+=n; }
    return { history: await all("SELECT * FROM history ORDER BY id DESC LIMIT 50"), hourlyCounts: cts, todayCount: tot, serverHour: h };
}));
app.post("/api/admin/stats/clear", auth, perm('stats'), H(async r=>{ const d=nowTW().d; await redis.del(K.HR+d); await run("DELETE FROM history WHERE date_str=?",[d]); log(r.user.nickname,"🗑️ 清空今日統計"); }));
app.post("/api/admin/stats/adjust", auth, perm('settings'), H(async r=>redis.hincrby(K.HR+nowTW().d, `${r.body.hour}_i`, r.body.delta)));
app.post("/api/admin/stats/calibrate", auth, perm('settings'), H(async r=>{
    const {d,h}=nowTW(), [iStr, pList]=await Promise.all([redis.get(K.ISS), redis.zrange(K.PASS,0,-1)]), hD=await redis.hgetall(K.HR+d);
    let cur=0; if(hD) for(let i=0;i<24;i++) cur += Math.max(0, parseInt(hD[`${i}_i`]||0)-parseInt(hD[`${i}_p`]||0));
    const diff = Math.max(0, (parseInt(iStr)||0) - (pList?pList.length:0)) - cur;
    if(diff) { await redis.hincrby(K.HR+d, `${h}_i`, diff); log(r.user.nickname, `⚖️ 校正統計 (${diff>0?'+':''}${diff})`); } return {diff};
}));
app.post("/api/admin/export-csv", auth, perm('stats'), H(async r=>{ const rows=await all("SELECT * FROM history WHERE date_str=? ORDER BY id ASC",[r.body.date||nowTW().d]); return {fileName:`export_${r.body.date}.csv`, csvData:"\uFEFFDate,Time,Number,Action,Operator,Wait(min)\n"+rows.map(d=>`${d.date_str},${new Date(d.timestamp).toLocaleTimeString('zh-TW')},${d.number},${d.action},${d.operator},${d.wait_time_min}`).join("\n")}; }));

app.post("/api/featured/add", auth, perm('settings'), H(async r=>{ await redis.rpush(K.FEAT, JSON.stringify(r.body)); io.emit("updateFeaturedContents",(await redis.lrange(K.FEAT,0,-1)).map(JSON.parse)); }));
app.post("/api/featured/get", auth, H(async ()=> (await redis.lrange(K.FEAT,0,-1)).map(JSON.parse)));
app.post("/api/featured/remove", auth, perm('settings'), H(async r=>{ const l=await redis.lrange(K.FEAT,0,-1), t=l.find(x=>x.includes(r.body.linkUrl)); if(t) await redis.lrem(K.FEAT, 1, t); io.emit("updateFeaturedContents",(await redis.lrange(K.FEAT,0,-1)).map(JSON.parse)); }));
app.post("/api/featured/clear", auth, perm('settings'), H(async ()=>{ await redis.del(K.FEAT); io.emit("updateFeaturedContents",[]); }));

app.post("/api/appointment/add", auth, perm('appointment'), H(async r=>{ await run("INSERT INTO appointments (number, scheduled_time) VALUES (?,?)",[r.body.number,new Date(r.body.timeStr).getTime()]); log(r.user.nickname,`📅 預約: ${r.body.number}`); bcAppt(); }));
app.post("/api/appointment/list", auth, perm('appointment'), H(async ()=>({ appointments: await all("SELECT * FROM appointments WHERE status='pending' ORDER BY scheduled_time ASC") })));
app.post("/api/appointment/remove", auth, perm('appointment'), H(async r=>{ await run("DELETE FROM appointments WHERE id=?",[r.body.id]); bcAppt(); }));

app.post("/set-sound-enabled", auth, perm('settings'), H(async r=>{ await redis.set("callsys:soundEnabled", r.body.enabled?"1":"0"); io.emit("updateSoundSetting", r.body.enabled); }));
app.post("/set-public-status", auth, perm('settings'), H(async r=>{ await redis.set("callsys:isPublic", r.body.isPublic?"1":"0"); io.emit("updatePublicStatus", r.body.isPublic); }));
app.post("/set-system-mode", auth, perm('settings'), H(async r=>{ await redis.set(K.MODE, r.body.mode); io.emit("updateSystemMode", r.body.mode); }));
app.post("/reset", auth, perm('settings'), H(r=>reset(r.user.nickname)));
app.post("/api/admin/broadcast", auth, H(async r=>{ io.emit("adminBroadcast", r.body.message); log(r.user.nickname, `📢 廣播: ${r.body.message}`); }));
app.post("/api/admin/roles/get", auth, H(async ()=> JSON.parse(await redis.get(K.ROL))||ROLES));
app.post("/api/admin/roles/update", auth, perm('settings'), H(async r=>{ if(r.user.role!=='super') throw 0; await redis.set(K.ROL, JSON.stringify(r.body.rolesConfig)); log(r.user.nickname,"🔧 修改權限"); }));

// --- LINE & Init ---
app.post("/api/admin/line-settings/get", auth, perm('line'), H(async ()=>({ "LINE Access Token":await redis.get(K.L.TOK), "LINE Channel Secret":await redis.get(K.L.SEC) })));
app.post("/api/admin/line-settings/save", auth, perm('line'), H(async r=>{ if(r.body["LINE Access Token"]) await redis.set(K.L.TOK, r.body["LINE Access Token"]); if(r.body["LINE Channel Secret"]) await redis.set(K.L.SEC, r.body["LINE Channel Secret"]); initLine(); log(r.user.nickname,"🔧 更新 LINE"); }));
app.post("/api/admin/line-settings/reset", auth, perm('line'), H(async ()=>{ await redis.del(K.L.TOK, K.L.SEC); initLine(); }));
app.post("/api/admin/line-settings/get-unlock-pass", auth, perm('line'), H(async ()=>({ password: await redis.get(K.L.PWD) })));
app.post("/api/admin/line-settings/save-pass", auth, perm('line'), H(async r=>redis.set(K.L.PWD, r.body.password)));

if (L_TOK) app.post('/callback', (req, res, next) => { if(!lineClient) return res.end(); line.middleware(lineClient.config)(req, res, next); }, (req,res)=>Promise.all(req.body.events.map(async e=>{
    if(e.type!=='message'||e.message.type!=='text') return;
    const t=e.message.text.trim(), u=e.source.userId, rp=x=>lineClient.replyMessage(e.replyToken,{type:'text',text:x});
    if(t==='後台登入') return rp((await redis.get(K.L.ADM+u)) ? `🔗 ${process.env.RENDER_EXTERNAL_URL}/admin.html` : (await redis.set(K.L.CTX+u,'WAIT_PWD','EX',120),"請輸入密碼"));
    if((await redis.get(K.L.CTX+u))==='WAIT_PWD' && t===(await redis.get(K.L.PWD)||`unlock${ADM_TOKEN}`)) { await redis.set(K.L.ADM+u,"1","EX",600); await redis.del(K.L.CTX+u); return rp("🔓 驗證成功"); }
    if(['?','status'].includes(t.toLowerCase())) { const [n,i,my]=await Promise.all([redis.get(K.CUR),redis.get(K.ISS),redis.get(K.L.USR+u)]); return rp(`叫號:${n||0} / 發號:${i||0}${my?`\n您的:${my}`:''}`); }
    if(/^\d+$/.test(t)) { const n=parseInt(t), c=parseInt(await redis.get(K.CUR))||0; if(n<=c) return rp("已過號"); await redis.multi().set(K.L.USR+u,n,'EX',43200).sadd(K.L.SUB+n,u).expire(K.L.SUB+n,43200).sadd(K.L.ACT,n).exec(); return rp(`設定成功: ${n}號`); }
    if(t.toLowerCase()==='cancel') { const n=await redis.get(K.L.USR+u); if(n){ await redis.multi().del(K.L.USR+u).srem(K.L.SUB+n,u).exec(); return rp("已取消"); } }
})).then(()=>res.json({})).catch(()=>res.end()));

require('node-cron').schedule('0 4 * * *', () => { reset('系統自動'); run("DELETE FROM history WHERE timestamp < ?", [Date.now()-2592e6]); }, { timezone: "Asia/Taipei" });
setInterval(() => { if(DB_Q.length){ const b=[...DB_Q]; DB_Q.length=0; db.serialize(()=>{ db.run("BEGIN"); const s=db.prepare("INSERT INTO history (date_str, timestamp, number, action, operator, wait_time_min) VALUES (?,?,?,?,?,?)"); b.forEach(r=>s.run([r.d,r.ts,r.n,r.act,r.op,r.w])); s.finalize(); db.run("COMMIT"); }); } }, FLUSH_MS);

redis.defineCommand("safeNextNumber", { numberOfKeys: 2, lua: `return (tonumber(redis.call("GET",KEYS[1]))or 0) < (tonumber(redis.call("GET",KEYS[2]))or 0) and redis.call("INCR",KEYS[1]) or -1` });
redis.defineCommand("decrIfPositive", { numberOfKeys: 1, lua: `local v=tonumber(redis.call("GET",KEYS[1])) return (v and v>0) and redis.call("DECR",KEYS[1]) or (v or 0)` });
(async() => { if (!(await redis.exists(K.ROL))) await redis.set(K.ROL, JSON.stringify(ROLES)); })();

io.use(async (s, next) => { try { const t = s.handshake.auth.token || (s.request.headers.cookie||'').match(/token=([^;]+)/)?.[1]; if(t) s.user = JSON.parse(await redis.get(K.SESS+t)); } catch{} next(); });
io.on("connection", async s => {
    if(s.user) { s.join("admin"); const sk=await io.in("admin").fetchSockets(); io.to("admin").emit("updateOnlineAdmins", [...new Map(sk.map(x=>x.user&&[x.user.username,x.user]).filter(Boolean)).values()]); s.emit("initAdminLogs", await redis.lrange(K.LOG,0,99)); bcAppt(); }
    s.join('public'); const [c,i,p,f,snd,pub,m] = await Promise.all([redis.get(K.CUR),redis.get(K.ISS),redis.zrange(K.PASS,0,-1),redis.lrange(K.FEAT,0,-1),redis.get("callsys:soundEnabled"),redis.get("callsys:isPublic"),redis.get(K.MODE)]);
    s.emit("update",Number(c)); s.emit("updateQueue",{current:Number(c),issued:Number(i)}); s.emit("updatePassed",p.map(Number)); s.emit("updateFeaturedContents",f.map(JSON.parse));
    s.emit("updateSoundSetting",snd==="1"); s.emit("updatePublicStatus",pub!=="0"); s.emit("updateSystemMode",m||'ticketing'); s.emit("updateWaitTime",await waitTime());
});

db.serialize(() => {
    db.run(`PRAGMA journal_mode=WAL;`); db.run(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, date_str TEXT, timestamp INTEGER, number INTEGER, action TEXT, operator TEXT, wait_time_min REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY, number INTEGER, scheduled_time INTEGER, status TEXT DEFAULT 'pending')`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_history_date ON history(date_str)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp)`, e => { if(e) process.exit(1); else { initLine(); server.listen(PORT, '0.0.0.0', ()=>console.log(`🚀 v17.2 Optimized on ${PORT}`)); } });
});
