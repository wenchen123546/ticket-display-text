/*
 * ==========================================
 * 伺服器 (index.js) - v2.0 Multi-Queue & Persistence
 * ==========================================
 */

const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const Redis = require("ioredis");
const helmet = require('helmet'); 
const rateLimit = require('express-rate-limit'); 
const { v4: uuidv4 } = require('uuid'); 
const bcrypt = require('bcrypt'); 
const line = require('@line/bot-sdk'); 
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const app = express();
const server = http.createServer(app);
// 安全性：限制 CORS Origin，防止惡意網站連線 Socket
const io = socketio(server, { 
    cors: { 
        origin: process.env.ALLOWED_ORIGIN || "*", 
        methods: ["GET", "POST"]
    }, 
    pingTimeout: 60000 
});

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin123"; 
const REDIS_URL = process.env.UPSTASH_REDIS_URL;
const SALT_ROUNDS = 10; 

// --- Database & Redis Init ---
let db;
const redis = new Redis(REDIS_URL, {
    tls: { rejectUnauthorized: false },
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// 初始化 SQLite 資料庫 (持久化存儲)
async function initDB() {
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            nickname TEXT,
            role TEXT DEFAULT 'normal'
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS queues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            prefix TEXT,
            current_num INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            username TEXT,
            action TEXT
        );
    `);

    // 預設建立一個主要佇列
    const mainQueue = await db.get("SELECT * FROM queues WHERE name = '一般'");
    if (!mainQueue) {
        await db.run("INSERT INTO queues (name, prefix, current_num) VALUES (?, ?, ?)", ['一般', '', 0]);
    }

    // 檢查是否有超級管理員，若無則建立
    const superUser = await db.get("SELECT * FROM users WHERE role = 'super'");
    if (!superUser) {
        const hash = await bcrypt.hash(ADMIN_TOKEN, SALT_ROUNDS);
        await db.run("INSERT INTO users (username, password, nickname, role) VALUES (?, ?, ?, ?)", 
            ['superadmin', hash, '超級管理員', 'super']);
        console.log("👑 初始化超級管理員: superadmin");
    }

    // 初始化設定
    await initSetting('multi_queue_enabled', '0');
    await initSetting('sound_enabled', '0');
    await initSetting('is_public', '1');
    await initSetting('line_liff_id', process.env.LINE_LIFF_ID || '');
}

async function initSetting(key, defaultVal) {
    const row = await db.get("SELECT value FROM settings WHERE key = ?", key);
    if (!row) {
        await db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [key, defaultVal]);
    }
}

initDB().catch(err => console.error("DB Init Error:", err));

// --- Keys & Constants ---
const SESSION_PREFIX = 'callsys:session:';
const KEY_PASSED_PREFIX = 'callsys:passed:'; // callsys:passed:{queueId}

// --- Middleware ---
app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://static.line-scdn.net"], // Add LINE CDN
        "frame-src": ["'self'", "https://static.line-scdn.net"],
        "connect-src": ["'self'", "wss:", "ws:", "https://api.line.me"]
      },
    },
}));
app.use(express.static("public"));
app.use(express.json()); 

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
// 安全性：針對寫入操作更嚴格的限制
const writeLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 60, message: "操作太頻繁，請稍後再試" });

const authMiddleware = async (req, res, next) => {
    try {
        const { token } = req.body; 
        if (!token) return res.status(401).json({ error: "未提供 Token" });
        const sessionKey = `${SESSION_PREFIX}${token}`;
        const sessionData = await redis.get(sessionKey);
        if (!sessionData) return res.status(403).json({ error: "Session 已過期" });
        req.user = JSON.parse(sessionData); 
        await redis.expire(sessionKey, 8 * 60 * 60); 
        next();
    } catch (e) { res.status(500).json({ error: "驗證錯誤" }); }
};

const superAdminAuthMiddleware = (req, res, next) => {
    if (req.user?.role === 'super') next();
    else res.status(403).json({ error: "權限不足" });
};

// --- Helpers ---
async function logAction(username, action) {
    try {
        await db.run("INSERT INTO logs (username, action) VALUES (?, ?)", [username, action]);
        // 同步發送給 Socket
        const logMsg = `[${new Date().toLocaleTimeString()}] [${username}] ${action}`;
        io.emit("newAdminLog", logMsg);
    } catch (e) { console.error("Log error:", e); }
}

async function getQueues() {
    return await db.all("SELECT * FROM queues ORDER BY id ASC");
}

async function broadcastState() {
    const queues = await getQueues();
    const isMulti = (await db.get("SELECT value FROM settings WHERE key='multi_queue_enabled'")).value === '1';
    const sound = (await db.get("SELECT value FROM settings WHERE key='sound_enabled'")).value === '1';
    const isPublic = (await db.get("SELECT value FROM settings WHERE key='is_public'")).value === '1';

    io.emit("updateState", {
        queues,
        isMulti,
        sound,
        isPublic
    });
}

// --- Routes ---

app.post("/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.get("SELECT * FROM users WHERE username = ?", username);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(403).json({ error: "帳號或密碼錯誤" });
        }
        const sessionToken = uuidv4();
        await redis.set(`${SESSION_PREFIX}${sessionToken}`, JSON.stringify({ 
            username: user.username, role: user.role, nickname: user.nickname 
        }), "EX", 28800);
        res.json({ success: true, token: sessionToken, role: user.role, username: user.username, nickname: user.nickname });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// APIs
app.use("/api", apiLimiter, authMiddleware); // 基本保護
app.use("/api/admin/write", writeLimiter); // 寫入保護

// 取得所有資料 (Initial Load)
app.post("/api/init-data", async (req, res) => {
    try {
        const queues = await getQueues();
        const settingsRaw = await db.all("SELECT * FROM settings");
        const settings = settingsRaw.reduce((acc, curr) => ({...acc, [curr.key]: curr.value}), {});
        
        // 取得每個 Queue 的過號
        const passedData = {};
        for(let q of queues) {
            const passed = await redis.zrange(`${KEY_PASSED_PREFIX}${q.id}`, 0, -1);
            passedData[q.id] = passed.map(Number);
        }

        res.json({ success: true, queues, settings, passedData });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 叫號變更 (支援多佇列)
app.post("/api/admin/write/change-number", async (req, res) => {
    const { direction, queueId, setNumber } = req.body;
    try {
        const queue = await db.get("SELECT * FROM queues WHERE id = ?", queueId);
        if(!queue) return res.status(404).json({error: "Queue not found"});

        let newNum = queue.current_num;
        if (setNumber !== undefined) {
            newNum = parseInt(setNumber);
        } else if (direction === 'next') {
            newNum++;
        } else if (direction === 'prev' && newNum > 0) {
            newNum--;
        }

        await db.run("UPDATE queues SET current_num = ? WHERE id = ?", [newNum, queueId]);
        await logAction(req.user.nickname, `${queue.name} 變更為 ${newNum}`);
        
        broadcastState();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 過號管理
app.post("/api/admin/write/passed", async (req, res) => {
    const { action, queueId, number } = req.body; // action: add, remove, clear
    const key = `${KEY_PASSED_PREFIX}${queueId}`;
    try {
        if(action === 'add') {
            await redis.zadd(key, number, number);
            await redis.zremrangebyrank(key, 0, -21); // Keep last 20
        } else if (action === 'remove') {
            await redis.zrem(key, number);
        } else if (action === 'clear') {
            await redis.del(key);
        }
        
        // Broadcast specific queue passed update
        const passed = await redis.zrange(key, 0, -1);
        io.emit("updatePassed", { queueId, numbers: passed.map(Number) });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 設定管理
app.post("/api/admin/write/settings", async (req, res) => {
    const { key, value } = req.body;
    try {
        await db.run("UPDATE settings SET value = ? WHERE key = ?", [value ? '1':'0', key]);
        await logAction(req.user.nickname, `更改設定 ${key} 為 ${value}`);
        broadcastState();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- Super Admin Functions ---

app.post("/api/super/manage-queue", authMiddleware, superAdminAuthMiddleware, async (req, res) => {
    const { action, name, prefix, id } = req.body; // action: create, delete
    try {
        if (action === 'create') {
            await db.run("INSERT INTO queues (name, prefix, current_num) VALUES (?, ?, 0)", [name, prefix || '']);
            await logAction(req.user.nickname, `建立新佇列: ${name}`);
        } else if (action === 'delete') {
            const count = (await db.get("SELECT COUNT(*) as c FROM queues")).c;
            if(count <= 1) return res.status(400).json({error: "至少需保留一個佇列"});
            await db.run("DELETE FROM queues WHERE id = ?", id);
            await redis.del(`${KEY_PASSED_PREFIX}${id}`);
            await logAction(req.user.nickname, `刪除佇列 ID: ${id}`);
        }
        broadcastState();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/super/logs", authMiddleware, async (req, res) => {
    try {
        const logs = await db.all("SELECT * FROM logs ORDER BY id DESC LIMIT 100");
        res.json({ success: true, logs });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- Socket.io ---
io.on("connection", async (socket) => {
    // Initial State Push
    if(db) {
        const queues = await getQueues();
        const settingsRaw = await db.all("SELECT * FROM settings");
        const settings = settingsRaw.reduce((acc, curr) => ({...acc, [curr.key]: curr.value}), {});
        
        socket.emit("updateState", {
            queues,
            isMulti: settings.multi_queue_enabled === '1',
            sound: settings.sound_enabled === '1',
            isPublic: settings.is_public === '1'
        });

        // Send passed numbers for all queues
        for(let q of queues) {
            const passed = await redis.zrange(`${KEY_PASSED_PREFIX}${q.id}`, 0, -1);
            socket.emit("updatePassed", { queueId: q.id, numbers: passed.map(Number) });
        }
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server v2.0 Ready on port ${PORT}`);
});
