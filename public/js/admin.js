/* ==========================================
 * 後台邏輯 (admin.js) - v48.0 Role & Fixes
 * ========================================== */
const $ = i => document.getElementById(i);
const $$ = s => document.querySelectorAll(s);
const mk = (t, c, txt, ev={}) => { const e = document.createElement(t); if(c) e.className=c; if(txt) e.textContent=txt; Object.entries(ev).forEach(([k,v])=>e[k]=v); return e; };

const i18n = {
    "zh-TW": { 
        status_conn:"✅ 已連線", status_dis:"連線中斷...", saved:"✅ 已儲存", denied:"❌ 權限不足", expired:"Session 過期", login_fail:"登入失敗",
        confirm:"⚠️ 確認", recall:"↩️ 重呼", edit:"✎", del:"✕", save:"✓", cancel:"✕",
        login_title:"請登入管理系統", login_btn:"登入", admin_panel:"管理後台", logout:"登出",
        nav_live:"現場控台", nav_stats:"數據報表", nav_settings:"系統設定", nav_line:"LINE設定",
        dash_curr:"目前叫號", dash_issued:"已發號至", dash_wait:"等待組數",
        card_call:"叫號控制", btn_prev:"◀ 上一號", btn_pass:"過號", btn_next:"下一號 ▶", lbl_assign:"指定 / 插隊", btn_exec:"執行", btn_reset_call:"↺ 重置叫號",
        card_issue:"發號機", btn_recall:"➖ 收回", btn_issue:"發號 ➕", lbl_fix_issue:"修正發號數", btn_fix:"修正", btn_reset_issue:"↺ 重置發號",
        card_passed:"過號名單", btn_clear_passed:"清空過號",
        card_stats:"流量分析", lbl_today:"今日人次", btn_refresh:"重整", btn_clear_stats:"⚠ 清空統計",
        card_logs:"操作日誌", btn_clear_logs:"清除日誌",
        card_sys:"系統", lbl_public:"🌐 開放前台", lbl_sound:"🔊 提示音", lbl_tts:"TTS 廣播", btn_play:"播放", lbl_mode:"模式", mode_online:"線上", mode_manual:"手動", btn_reset_all:"💥 全域重置",
        card_online:"在線管理", card_links:"連結管理", btn_clear_links:"清空連結",
        card_users:"帳號管理", lbl_add_user:"新增帳號", 
        btn_save:"儲存", btn_save_settings:"儲存設定", btn_restore:"恢復預設",
        modal_edit:"編輯數據", btn_done:"完成",
        ph_account:"帳號", ph_password:"密碼", ph_nick:"暱稱", ph_link_name:"名稱"
    },
    "en": { 
        status_conn:"✅ Connected", status_dis:"Disconnected...", saved:"✅ Saved", denied:"❌ Denied", expired:"Expired", login_fail:"Failed",
        confirm:"⚠️ Confirm", recall:"↩️ Recall", edit:"Edit", del:"Del", save:"Save", cancel:"Cancel",
        login_title:"Login Required", login_btn:"Login", admin_panel:"Admin Panel", logout:"Logout",
        nav_live:"Live Console", nav_stats:"Statistics", nav_settings:"Settings", nav_line:"LINE Config",
        dash_curr:"Current", dash_issued:"Issued", dash_wait:"Waiting",
        card_call:"Call Control", btn_prev:"◀ Prev", btn_pass:"Pass", btn_next:"Next ▶", lbl_assign:"Assign / Jump", btn_exec:"Set", btn_reset_call:"↺ Reset Call",
        card_issue:"Ticket Issue", btn_recall:"➖ Recall", btn_issue:"Issue ➕", lbl_fix_issue:"Fix Issued", btn_fix:"Fix", btn_reset_issue:"↺ Reset Issue",
        card_passed:"Passed List", btn_clear_passed:"Clear Passed",
        card_stats:"Traffic Stats", lbl_today:"Today Total", btn_refresh:"Refresh", btn_clear_stats:"⚠ Clear Stats",
        card_logs:"System Logs", btn_clear_logs:"Clear Logs",
        card_sys:"System", lbl_public:"🌐 Public Page", lbl_sound:"🔊 Sound", lbl_tts:"TTS Broadcast", btn_play:"Play", lbl_mode:"Mode", mode_online:"Online", mode_manual:"Manual", btn_reset_all:"💥 Factory Reset",
        card_online:"Online Admins", card_links:"Links Manager", btn_clear_links:"Clear Links",
        card_users:"User Manager", lbl_add_user:"Add User",
        btn_save:"Save", btn_save_settings:"Save Settings", btn_restore:"Restore Default",
        modal_edit:"Edit Data", btn_done:"Done",
        ph_account:"Account", ph_password:"Password", ph_nick:"Nickname", ph_link_name:"Name"
    }
};

let curLang = localStorage.getItem('callsys_lang')||'zh-TW', T = i18n[curLang];
let token="", userRole="normal", username="", uniqueUser="", toastTimer;
const socket = io({ autoConnect: false, auth: { token: "" } });

function toast(msg, type='info') {
    const t = $("toast-notification"); if(!t) return;
    t.textContent = msg; t.className = `${type} show`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

function updateLangUI() {
    T = i18n[curLang];
    $$('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if(T[k]) el.textContent = T[k]; });
    $$('[data-i18n-ph]').forEach(el => { const k = el.getAttribute('data-i18n-ph'); if(T[k]) el.placeholder = T[k]; });
    loadUsers(); loadStats(); loadLineSettings();
    req("/api/featured/get").then(res => { if(res) socket.emit("updateFeaturedContents", res); });
}

async function req(url, data={}, lockBtn=null) {
    if(lockBtn) lockBtn.disabled=true;
    try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, token }) });
        const res = await r.json();
        if(!r.ok) {
            if(r.status===403) { toast(res.error?.includes("權限")?T.denied:T.expired, "error"); if(!res.error?.includes("權限")) logout(); }
            else toast(`❌ ${res.error||'Error'}`, "error");
            return null;
        }
        return res;
    } catch(e) { toast(`❌ ${e.message}`, "error"); return null; }
    finally { if(lockBtn) setTimeout(()=>lockBtn.disabled=false, 300); }
}

function confirmBtn(el, origTxt, action) {
    if(!el) return;
    let t, c=5;
    el.onclick = (e) => {
        e.stopPropagation();
        if(el.classList.contains("is-confirming")) { action(); reset(); } 
        else { el.classList.add("is-confirming"); el.textContent = `${T.confirm} (${c})`; t = setInterval(() => { c--; el.textContent = `${T.confirm} (${c})`; if(c<=0) reset(); }, 1000); }
    };
    const reset = () => { clearInterval(t); el.classList.remove("is-confirming"); el.textContent = origTxt; c=5; };
}

function checkSession() {
    const storedToken = localStorage.getItem('callsys_token');
    const storedUser = localStorage.getItem('callsys_user');
    const storedRole = localStorage.getItem('callsys_role'); // "super" or "normal"
    const storedNick = localStorage.getItem('callsys_nick');
    if(storedToken && storedUser) {
        token = storedToken; uniqueUser = storedUser; userRole = storedRole; username = storedNick;
        showPanel();
    } else { showLogin(); }
}
function logout() {
    localStorage.removeItem('callsys_token'); localStorage.removeItem('callsys_user');
    localStorage.removeItem('callsys_role'); localStorage.removeItem('callsys_nick');
    token=""; location.reload();
}

function showLogin() { $("login-container").style.display="block"; $("admin-panel").style.display="none"; socket.disconnect(); }
async function showPanel() {
    $("login-container").style.display="none"; $("admin-panel").style.display="flex";
    if($("sidebar-user-info")) $("sidebar-user-info").textContent = `Hi, ${username}`;
    const isSuper = userRole === 'super';
    ["card-user-management", "btn-export-csv", "mode-switcher-group", "unlock-pwd-group"].forEach(id => { if($(id)) $(id).style.display = isSuper ? "block" : "none"; });
    if($('button[data-target="section-line"]')) $('button[data-target="section-line"]').style.display = isSuper?"flex":"none";
    socket.auth.token = token; socket.connect();
    
    updateLangUI(); 
    try { await loadStats(); } catch(e){ console.error(e); }
    if(isSuper) { 
        try { await loadUsers(); } catch(e){ console.error(e); }
        try { loadLineSettings(); } catch(e){ console.error(e); }
    }
}

$("btn-logout")?.addEventListener("click", logout);
$("login-button").onclick = async () => {
    const b=$("login-button"); b.disabled=true;
    const res = await fetch("/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username:$("username-input").value, password:$("password-input").value})}).then(r=>r.json()).catch(()=>({error:T.login_fail}));
    if(res.token) { 
        token=res.token; userRole=res.role; username=res.nickname; uniqueUser=res.username;
        localStorage.setItem('callsys_token', token); localStorage.setItem('callsys_user', uniqueUser);
        localStorage.setItem('callsys_role', userRole); localStorage.setItem('callsys_nick', username);
        showPanel(); 
    } else { $("login-error").textContent=res.error||T.login_fail; }
    b.disabled=false;
};

socket.on("connect", () => { $("status-bar").classList.remove("visible"); toast(`${T.status_conn} (${username})`, "success"); });
socket.on("disconnect", () => { $("status-bar").classList.add("visible"); });
socket.on("updateQueue", d => { $("number").textContent=d.current; $("issued-number").textContent=d.issued; $("waiting-count").textContent=Math.max(0, d.issued-d.current); loadStats(); });
socket.on("update", n => { $("number").textContent=n; loadStats(); });
socket.on("initAdminLogs", l => renderLogs(l, true));
socket.on("newAdminLog", l => renderLogs([l], false));
// [修復] Public Toggle 同步
socket.on("updatePublicStatus", b => { if($("public-toggle")) $("public-toggle").checked = b; });
socket.on("updateSoundSetting", b => { if($("sound-toggle")) $("sound-toggle").checked=b; });
socket.on("updateSystemMode", m => $$('input[name="systemMode"]').forEach(r => r.checked=(r.value===m)));
socket.on("updatePassed", list => {
    const ul = $("passed-list-ui"); if(!ul) return; ul.innerHTML="";
    list.forEach(n => {
        const li = mk("li");
        const div = mk("div", null, null, {style:"display:flex; gap:10px; align-items:center;"});
        div.append(mk("span", null, n, {style:"font-weight:bold"}), mk("button", "btn-secondary", T.recall, {onclick:()=>{ if(confirm(`Recall ${n}?`)) req("/api/control/recall-passed",{number:n}); }}));
        const del = mk("button", "delete-item-btn", T.del); confirmBtn(del, T.del, ()=>req("/api/passed/remove",{number:n}));
        li.append(div, del); ul.appendChild(li);
    });
});

// User Management (Updated for Roles)
async function loadUsers() {
    const ul = $("user-list-ui"); if(!ul) return;
    const d = await req("/api/admin/users");
    if(!d || !d.users) return; ul.innerHTML="";
    
    // Role Options
    const roleOpts = { 'VIEWER':'Viewer', 'OPERATOR':'Operator', 'MANAGER':'Manager', 'ADMIN':'Admin' };

    d.users.forEach(u => {
        const li = mk("li");
        const view = mk("div", null, null, {style:"display:flex; justify-content:space-between; width:100%; align-items:center;"});
        
        const info = mk("div", null, null, {style:"display:flex; flex-direction:column;"});
        const roleLabel = roleOpts[u.role] || u.role;
        info.append(mk("span", null, `${u.role==='ADMIN'?'👑':'👤'} ${u.nickname}`, {style:"font-weight:600"}), mk("small", null, `${u.username} • ${roleLabel}`, {style:"color:#666;"}));
        
        const acts = mk("div", null, null, {style:"display:flex; gap:5px; flex-shrink:0;"});
        
        // Role Selector (Only if Super Admin)
        if(u.username !== 'superadmin' && userRole === 'super') {
            const roleSel = mk("select", null, null, {style:"padding:2px; font-size:0.8rem;"});
            Object.keys(roleOpts).forEach(k => { const o = mk("option",null,roleOpts[k]); o.value=k; if(u.role===k) o.selected=true; roleSel.appendChild(o); });
            roleSel.onchange = async () => { if(await req("/api/admin/set-role", {targetUsername:u.username, newRole:roleSel.value})) toast(T.saved, "success"); };
            acts.appendChild(roleSel);
            
            const del = mk("button", "delete-item-btn", T.del); 
            confirmBtn(del, T.del, async()=>{ await req("/api/admin/del-user",{delUsername:u.username}); loadUsers(); });
            acts.appendChild(del);
        }

        view.append(info, acts); li.appendChild(view); ul.appendChild(li);
    });
}

// ... (Other functions: loadLineSettings, loadStats, renderChart, etc. remain same) ...
// [省略部分與 v43 相同，請確保 loadStats 邏輯不變]
async function loadStats() {
    const ul = $("stats-list-ui"); const d = await req("/api/admin/stats");
    if(d && d.hourlyCounts) {
        if($("stats-today-count")) $("stats-today-count").textContent = d.todayCount;
        renderChart(d.hourlyCounts, d.serverHour);
        if(ul) ul.innerHTML = d.history.map(h => {
             // 處理 Redis(JSON String) 或 SQLite(Object) 的差異
             const item = typeof h === 'string' ? JSON.parse(h) : h;
             return `<li><span>${new Date(item.time||item.timestamp).toLocaleTimeString('zh-TW',{hour12:false})} - ${item.num||item.number} <small>(${item.operator})</small></span></li>`;
        }).join("") || `<li>[Empty]</li>`;
    }
}
function renderChart(counts, curHr) {
    const c = $("hourly-chart"); if(!c) return; c.innerHTML=""; 
    const safeCounts = counts || new Array(24).fill(0);
    const max = Math.max(...safeCounts, 1);
    safeCounts.forEach((val, i) => {
        const col = mk("div", `chart-col ${i===curHr?'current':''}`, null, {onclick:()=>openStatModal(i, val)});
        col.innerHTML = `<div class="chart-val">${val||''}</div><div class="chart-bar" style="height:${Math.max(val/max*100, 2)}%; background:${val===0?'#e5e7eb':''}"></div><div class="chart-label">${String(i).padStart(2,'0')}</div>`;
        c.appendChild(col);
    });
}
function renderLogs(logs, init) {
    const ul = $("admin-log-ui"); if(!ul) return; if(init) ul.innerHTML="";
    if(!logs?.length && init) { ul.innerHTML="<li>[No Logs]</li>"; return; }
    logs.forEach(msg => { const li=mk("li", null, msg); init ? ul.appendChild(li) : ul.insertBefore(li, ul.firstChild); });
}

// Event Listeners
const act = (id, api, data={}) => $(id)?.addEventListener("click", () => req(api, data, $(id)));
act("btn-call-prev", "/api/control/call", {direction:"prev"});
act("btn-call-next", "/api/control/call", {direction:"next"});
act("btn-mark-passed", "/api/control/pass-current");
act("btn-issue-prev", "/api/control/issue", {direction:"prev"});
act("btn-issue-next", "/api/control/issue", {direction:"next"});

$("setNumber")?.addEventListener("click", async()=>{ const n=$("manualNumber").value; if(n>0 && await req("/api/control/set-call",{number:n})) { $("manualNumber").value=""; toast(T.saved,"success"); } });
$("setIssuedNumber")?.addEventListener("click", async()=>{ const n=$("manualIssuedNumber").value; if(n>=0 && await req("/api/control/set-issue",{number:n})) { $("manualIssuedNumber").value=""; toast(T.saved,"success"); } });
$("add-passed-btn")?.addEventListener("click", async()=>{ const n=$("new-passed-number").value; if(n>0 && await req("/api/passed/add",{number:n})) $("new-passed-number").value=""; });
$("btn-broadcast")?.addEventListener("click", async()=>{ const m=$("broadcast-msg").value; if(m && await req("/api/admin/broadcast",{message:m})) { toast("📢 Sent","success"); $("broadcast-msg").value=""; } });

$("quick-add-1")?.addEventListener("click", async()=>{ await req("/api/control/call", {direction:"next"}); }); 
$("quick-add-5")?.addEventListener("click", async()=>{ const c=parseInt($("number").textContent)||0; $("manualNumber").value = c + 5; });
$("quick-clear")?.addEventListener("click", ()=>{ $("manualNumber").value=""; });

confirmBtn($("resetNumber"), "↺ 重置叫號", ()=>req("/api/control/set-call",{number:0}));
confirmBtn($("resetIssued"), "↺ 重置發號", ()=>req("/api/control/set-issue",{number:0}));
confirmBtn($("resetPassed"), "清空列表", ()=>req("/api/passed/clear"));
confirmBtn($("resetAll"), "💥 全域重置", ()=>req("/reset"));
confirmBtn($("btn-clear-logs"), "清除日誌", ()=>req("/api/logs/clear"));
confirmBtn($("btn-clear-stats"), "🗑️ 清空統計", ()=>req("/api/admin/stats/clear").then(()=>loadStats()));

// Toggle Listeners (Debounced)
$("sound-toggle")?.addEventListener("change", e => req("/set-sound-enabled", {enabled:e.target.checked}));
$("public-toggle")?.addEventListener("change", e => {
    // 立即發送請求
    req("/set-public-status", {isPublic:e.target.checked});
});
$$('input[name="systemMode"]').forEach(r => r.addEventListener("change", ()=>confirm("Switch Mode?")?req("/set-system-mode", {mode:r.value}):(r.checked=!r.checked)));

// Add User with Role
$("add-user-btn")?.addEventListener("click", async()=>{ 
    const u=$("new-user-username").value, p=$("new-user-password").value, n=$("new-user-nickname").value, r=$("new-user-role")?.value;
    if(await req("/api/admin/add-user", {newUsername:u, newPassword:p, newNickname:n, newRole:r})) { 
        toast(T.saved,"success"); $("new-user-username").value=""; $("new-user-password").value=""; $("new-user-nickname").value=""; loadUsers(); 
    }
});

// Init
document.addEventListener("DOMContentLoaded", () => {
    $("admin-lang-selector").value = curLang; checkSession();
    // ... (Enter key bindings)
});
