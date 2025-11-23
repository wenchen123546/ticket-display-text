// --- 1. 初始化 ---
const socket = io();

// DOM 元素
const queueGrid = document.getElementById("queue-grid");
const passedListEl = document.getElementById("passedList");
const featuredContainerEl = document.getElementById("featured-container");
const statusBar = document.getElementById("status-bar");
const lastUpdatedEl = document.getElementById("last-updated");
const notifySound = document.getElementById("notify-sound");
const soundPrompt = document.getElementById("sound-prompt");

// 通知表單
const notifyBtn = document.getElementById("enable-notify-btn");
const myNumInput = document.getElementById("my-number");
const queueSelect = document.getElementById("queue-select");
const notifyStatus = document.getElementById("notify-status");
const waitTimeEl = document.getElementById("estimated-wait");

// 狀態變數
let isSoundEnabled = false;
let isLocallyMuted = false;
let audioPermissionGranted = false;
let ttsEnabled = false;
let isPublic = true;
let queuesData = []; // 儲存所有佇列狀態
let myTarget = { queueId: null, number: null };

// --- 2. Socket 事件 ---
socket.on("connect", () => {
    console.log("Socket 已連線");
    statusBar.classList.remove("visible");
    // LIFF 初始化 (如果有的話)
    if (window.liff) initializeLiff();
});

socket.on("disconnect", () => {
    statusBar.classList.add("visible");
    lastUpdatedEl.textContent = "連線中斷...";
});

// 接收完整資料 (初始化或重置時)
socket.on("initData", (data) => {
    handleQueueUpdate(data.queues);
    renderPassed(data.passed);
    renderFeatured(data.featured);
    updatePublicStatus(data.isPublic);
});

// 接收單一或全部佇列更新
socket.on("updateQueues", (queues) => {
    handleQueueUpdate(queues);
});

socket.on("updatePassed", (numbers) => renderPassed(numbers));
socket.on("updateFeaturedContents", (contents) => renderFeatured(contents));
socket.on("updatePublicStatus", (status) => updatePublicStatus(status));
socket.on("adminBroadcast", (msg) => {
    speakText(`公告：${msg}`);
    alert(`📢 店家公告：${msg}`);
});

// --- 3. 核心邏輯 ---

function handleQueueUpdate(newQueues) {
    // 更新數據
    queuesData = newQueues;
    renderQueues(queuesData);
    updateNotifySelect(queuesData);
    checkMyNumber();
    
    lastUpdatedEl.textContent = "剛剛更新";
}

function renderQueues(queues) {
    queueGrid.innerHTML = "";
    
    queues.forEach(q => {
        const card = document.createElement("div");
        card.className = "queue-card";
        card.style.borderTopColor = q.color || "#2563eb"; // 支援自定義顏色

        const prevNum = getPreviousNumber(q.id);
        const isUpdated = prevNum !== q.current;

        card.innerHTML = `
            <div class="queue-name">${q.name}</div>
            <div class="queue-prefix">代號: ${q.prefix}</div>
            <div class="queue-number ${isUpdated ? 'updated' : ''}" id="num-${q.id}">${q.current}</div>
            <div class="queue-wait-info">等待人數: ${q.waiting || 0}</div>
        `;
        
        queueGrid.appendChild(card);

        // 音效與語音
        if (isUpdated && isSoundEnabled && !isLocallyMuted) {
            playNotificationSound();
            setTimeout(() => {
                speakText(`${q.name}，${q.current}號`, 0.9);
            }, 800);
        }
    });
}

// 輔助：暫存舊號碼以比對變化
const prevNumbers = new Map();
function getPreviousNumber(queueId) {
    const val = prevNumbers.get(queueId);
    const current = queuesData.find(q => q.id === queueId)?.current || 0;
    prevNumbers.set(queueId, current);
    return val;
}

function updateNotifySelect(queues) {
    // 如果選項數量變了，才重新渲染
    if (queueSelect.options.length - 1 !== queues.length) {
        const oldVal = queueSelect.value;
        queueSelect.innerHTML = '<option value="" disabled selected>選擇櫃台</option>';
        queues.forEach(q => {
            const opt = document.createElement("option");
            opt.value = q.id;
            opt.textContent = `${q.name} (${q.prefix})`;
            queueSelect.appendChild(opt);
        });
        if (oldVal) queueSelect.value = oldVal;
    }
}

// --- 4. 檢查到號通知 ---
function checkMyNumber() {
    if (!myTarget.queueId || !myTarget.number) return;

    const q = queuesData.find(x => x.id === parseInt(myTarget.queueId));
    if (!q) return;

    const diff = myTarget.number - q.current;

    if (diff > 0) {
        waitTimeEl.style.display = "block";
        waitTimeEl.textContent = `前還有 ${diff} 組`;
        
        if (diff <= 3) {
            if (document.hidden && Notification.permission === "granted") {
                new Notification("叫號提醒", { body: `${q.name} 剩 ${diff} 組！目前 ${q.current} 號` });
            }
        }
    } else if (diff === 0) {
        // 到號
        notifyStatus.textContent = "🎉 已到號！";
        notifyStatus.style.color = "#2563eb";
        waitTimeEl.style.display = "none";
        triggerConfetti();
        
        if (isSoundEnabled && !isLocallyMuted) speakText("恭喜！輪到您了");
        if (document.hidden && Notification.permission === "granted") {
            new Notification("到號通知", { body: `輪到您了！請前往 ${q.name}` });
        }
        
        // 清除設定
        myTarget = { queueId: null, number: null };
    } else {
        // 過號
        notifyStatus.textContent = "⚠️ 您已過號";
        waitTimeEl.style.display = "none";
    }
}

// --- 5. 其他 UI 渲染 ---
function renderPassed(numbers) {
    passedListEl.innerHTML = "";
    if (!numbers || numbers.length === 0) {
        passedListEl.innerHTML = '<span style="color:#999">無</span>';
        return;
    }
    numbers.forEach(item => {
        // item 結構可能是 { queueName: 'A', number: 10 }
        const li = document.createElement("li");
        li.textContent = `${item.queuePrefix}-${item.number}`;
        passedListEl.appendChild(li);
    });
}

function renderFeatured(contents) {
    featuredContainerEl.innerHTML = "";
    if (!contents || contents.length === 0) {
        featuredContainerEl.style.display = 'none';
        return;
    }
    featuredContainerEl.style.display = 'flex';
    contents.forEach(c => {
        const a = document.createElement("a");
        a.className = "featured-link";
        a.href = c.linkUrl; a.target = "_blank"; a.textContent = c.linkText;
        featuredContainerEl.appendChild(a);
    });
}

function updatePublicStatus(status) {
    isPublic = status;
    document.body.classList.toggle("is-closed", !isPublic);
    if (!isPublic) { socket.disconnect(); statusBar.classList.remove("visible"); }
    else { if(!socket.connected) socket.connect(); }
}

// --- 6. 互動與工具 ---

// 設定通知
notifyBtn.addEventListener("click", () => {
    const qId = queueSelect.value;
    const num = parseInt(myNumInput.value);
    
    if (!qId || !num) return alert("請選擇櫃台並輸入號碼");

    if ("Notification" in window) {
        Notification.requestPermission().then(p => {
            if (p === "granted") {
                myTarget = { queueId: parseInt(qId), number: num };
                const qName = queuesData.find(q => q.id == qId)?.name;
                notifyStatus.textContent = `✅ 已設定：${qName} ${num}號`;
                notifyStatus.style.color = "#10b981";
                checkMyNumber();
            } else {
                alert("請允許通知權限才能收到提醒");
            }
        });
    }
});

// 音效控制
soundPrompt.addEventListener("click", () => {
    playNotificationSound(); // 嘗試播放以獲取權限
    isSoundEnabled = true;
    isLocallyMuted = false;
    soundPrompt.innerHTML = '<span class="emoji">🔊</span> 音效已開啟';
    soundPrompt.style.opacity = "0.5";
});

function playNotificationSound() {
    if (!notifySound) return;
    notifySound.play().then(() => {
        audioPermissionGranted = true;
        ttsEnabled = true;
    }).catch(e => console.log("Autoplay blocked", e));
}

function speakText(text, rate = 1) {
    if (!ttsEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW'; u.rate = rate;
    window.speechSynthesis.speak(u);
}

function triggerConfetti() {
    if (typeof confetti === 'undefined') return;
    confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
}

// LIFF 初始化 (選擇性)
async function initializeLiff() {
    // 需要在後端設置環境變數 LIFF_ID
    // 這裡假設從後端 API 獲取 LIFF ID 或直接寫死
    // await liff.init({ liffId: "YOUR_LIFF_ID" });
    // if (liff.isLoggedIn()) { const profile = await liff.getProfile(); ... }
}
