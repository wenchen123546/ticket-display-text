// --- 1. Socket.io 初始化 ---
const socket = io();

// --- 2. 元素節點 (DOM) ---
const numberEl = document.getElementById("number");
const passedListEl = document.getElementById("passedList");
const featuredContainerEl = document.getElementById("featured-container");
const statusBar = document.getElementById("status-bar");
const notifySound = document.getElementById("notify-sound");
const lastUpdatedEl = document.getElementById("last-updated");
const featuredEmptyMsg = document.getElementById("featured-empty-msg");
const passedContainerEl = document.getElementById("passed-container"); 
const soundPrompt = document.getElementById("sound-prompt");
const copyLinkPrompt = document.getElementById("copy-link-prompt"); 

// 【新】通知相關 DOM
const notifyBtn = document.getElementById("enable-notify-btn");
const myNumInput = document.getElementById("my-number");
const notifyStatus = document.getElementById("notify-status");

// --- 3. 前台全域狀態 ---
let isSoundEnabled = false; // 管理員設定
let isLocallyMuted = false; // 本地靜音
let lastUpdateTime = null;
let isPublic = true;
let audioPermissionGranted = false;
let isCopying = false; 

// 【新】功能狀態
let ttsEnabled = false; 
let myTargetNumber = null;

// --- 4. Socket.io 連線狀態監聽 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    if (isPublic) {
        statusBar.classList.remove("visible"); 
    }
});

socket.on("disconnect", () => {
    console.log("Socket.io 已斷線");
    if (isPublic) {
        statusBar.classList.add("visible"); 
    }
    lastUpdatedEl.textContent = "連線中斷...";
});

socket.on("initialStateError", (errorMsg) => {
    console.error("無法載入初始狀態:", errorMsg);
    alert(errorMsg); 
    lastUpdatedEl.textContent = "載入失敗";
});

// --- 5. Socket.io 資料更新監聽 ---
socket.on("updateSoundSetting", (isEnabled) => {
    console.log("音效設定更新:", isEnabled);
    isSoundEnabled = isEnabled;
});

socket.on("updatePublicStatus", (status) => {
    console.log("Public status updated:", status);
    isPublic = status;
    document.body.classList.toggle("is-closed", !isPublic); 

    if (isPublic) {
        socket.connect();
    } else {
        socket.disconnect();
        statusBar.classList.remove("visible");
    }
});

socket.on("updateTimestamp", (timestamp) => {
    lastUpdateTime = new Date(timestamp); 
    const timeString = lastUpdateTime.toLocaleTimeString('zh-TW');
    lastUpdatedEl.textContent = `最後更新於 ${timeString}`;
});

// --- 【新】 TTS (語音合成) 函式 ---
function speakNumber(num) {
    if (!ttsEnabled || !('speechSynthesis' in window)) return;
    
    // 取消之前的發音，避免堆疊
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(`現在號碼，${num}號`);
    utterance.lang = 'zh-TW'; 
    utterance.rate = 0.9; // 語速稍慢
    utterance.volume = 1; 
    
    window.speechSynthesis.speak(utterance);
}

// --- 【新】 系統通知 (Notification API) 函式 ---
function sendSystemNotification(title, body) {
    if (!("Notification" in window)) return;
    
    if (Notification.permission === "granted") {
        new Notification(title, { body: body, icon: "/icons/icon-192.png" });
    }
}

// 播放提示音 (舊有邏輯優化)
function playNotificationSound() {
    if (!notifySound) return;

    if (!audioPermissionGranted) {
        const playPromise = notifySound.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log("音效權限已自動取得");
                audioPermissionGranted = true;
                // 自動啟用 TTS
                ttsEnabled = true; 
                updateMuteButtons(false); 
                
                if (!isSoundEnabled || isLocallyMuted) {
                    notifySound.pause(); 
                    notifySound.currentTime = 0;
                }
            }).catch(error => {
                console.warn("音效播放失敗，等待使用者互動:", error);
                if (soundPrompt) {
                    soundPrompt.style.display = 'block'; 
                    soundPrompt.innerHTML = '<span class="emoji">🔊</span> 點此啟用提示音效';
                    soundPrompt.classList.remove("is-active");
                }
                audioPermissionGranted = false;
            });
        }
        return; 
    }

    if (!isSoundEnabled || isLocallyMuted) {
        return; 
    }
    
    notifySound.play().catch(e => console.warn("音效播放失敗 (已有權限):", e));
}

socket.on("update", (num) => {
    // 1. 播放音效
    playNotificationSound(); 

    // 2. 【新】 執行 TTS (延遲 0.8秒，避免跟叮咚聲重疊)
    setTimeout(() => {
        // 檢查號碼是否真的變更
        if (numberEl.textContent !== String(num)) {
             // 檢查本地靜音與管理員設定 (TTS 跟隨靜音設定)
             if (isSoundEnabled && !isLocallyMuted) {
                 speakNumber(num); 
             }
        }
    }, 800);

    // 3. 【新】 執行到號提醒通知
    if (myTargetNumber) {
        const current = Number(num);
        const target = Number(myTargetNumber);
        const diff = target - current;

        // 邏輯：剩 3 號時提醒，或剛好輪到時提醒
        if (diff <= 3 && diff >= 0) {
            let msg = "";
            if (diff === 0) msg = `輪到您了！現在是 ${current} 號`;
            else msg = `快到了！還剩 ${diff} 組，目前 ${current} 號`;
            
            // 只有當網頁在背景執行(hidden)時才發送通知，避免干擾
            if (document.hidden) {
                sendSystemNotification("叫號提醒", msg);
            }
        }
    }

    if (numberEl.textContent !== String(num)) {
        numberEl.textContent = num;
        document.title = `目前號碼 ${num} - 候位顯示`;
        numberEl.classList.add("updated");
        setTimeout(() => { numberEl.classList.remove("updated"); }, 500);
    }
});

socket.on("updatePassed", (numbers) => {
    passedListEl.innerHTML = "";
    const isEmpty = !numbers || numbers.length === 0;
    passedContainerEl.classList.toggle("is-empty", isEmpty);
    if (!isEmpty) {
        const fragment = document.createDocumentFragment();
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            fragment.appendChild(li);
        });
        passedListEl.appendChild(fragment);
    }
});

socket.on("updateFeaturedContents", (contents) => {
    featuredContainerEl.innerHTML = ""; 
    const emptyMsgNode = featuredEmptyMsg.cloneNode(true);
    featuredContainerEl.appendChild(emptyMsgNode);
    const fragment = document.createDocumentFragment();
    let hasVisibleLinks = false; 
    if (contents && contents.length > 0) {
        contents.forEach(item => {
            if (item && item.linkText && item.linkUrl) {
                const a = document.createElement("a");
                a.className = "featured-link";
                a.target = "_blank";
                a.href = item.linkUrl;
                a.textContent = item.linkText;
                fragment.appendChild(a);
                hasVisibleLinks = true; 
            }
        });
    }
    featuredContainerEl.appendChild(fragment);
    featuredContainerEl.classList.toggle("is-empty", !hasVisibleLinks); 
});

/* 6. QR Code (保持不變) */
try {
    const qrPlaceholder = document.getElementById("qr-code-placeholder");
    if (qrPlaceholder) {
        new QRCode(qrPlaceholder, {
            text: window.location.href,
            width: 120, height: 120, correctLevel: QRCode.CorrectLevel.M 
        });
    }
} catch (e) {}

/* 7. 相對時間 (保持不變) */
try {
    function formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 10) return "剛剛";
        if (seconds < 60) return `${seconds} 秒前`;
        const minutes = Math.floor(seconds / 60);
        if (minutes === 1) return "1 分鐘前";
        return `${minutes} 分鐘前`;
    }
    setInterval(() => {
        if (lastUpdateTime && socket.connected && isPublic) { 
            const relativeTime = formatTimeAgo(lastUpdateTime);
            lastUpdatedEl.textContent = `最後更新於 ${relativeTime}`;
        }
    }, 10000); 
} catch (e) {}

/*
 * =============================================
 * 8. 音效啟用 / TTS / 個人靜音 / 通知
 * =============================================
 */

function updateMuteButtons(mutedState) {
    isLocallyMuted = mutedState;
    // 同步 TTS 狀態
    if (mutedState) ttsEnabled = false;
    else if (audioPermissionGranted) ttsEnabled = true;
    
    if (audioPermissionGranted && soundPrompt) {
        soundPrompt.style.display = 'block'; 
        if (mutedState) {
            soundPrompt.innerHTML = '<span class="emoji">🔊</span> 點此啟用提示音效';
            soundPrompt.classList.remove("is-active");
        } else {
            soundPrompt.innerHTML = '<span class="emoji">🔇</span> 點此關閉提示音效'; 
            soundPrompt.classList.add("is-active");
        }
    }
}

if (soundPrompt) {
    soundPrompt.addEventListener("click", () => {
        if (!audioPermissionGranted) {
            if (notifySound) {
                notifySound.play().then(() => {
                    audioPermissionGranted = true;
                    ttsEnabled = true; // 取得權限後啟用 TTS
                    updateMuteButtons(false); 
                    // 測試發音
                    speakNumber("測試"); 
                }).catch(e => {
                    console.error("點擊提示後播放失敗:", e);
                    soundPrompt.style.display = 'none'; 
                });
            }
        } else {
            updateMuteButtons(!isLocallyMuted); 
        }
    });
}

// 【新】 綁定通知按鈕
if (notifyBtn) {
    notifyBtn.addEventListener("click", () => {
        if (!("Notification" in window)) {
            alert("您的瀏覽器不支援通知功能");
            return;
        }

        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                const val = myNumInput.value;
                if (val) {
                    myTargetNumber = parseInt(val);
                    notifyStatus.textContent = `✅ 已設定：當號碼接近 ${myTargetNumber} 時會通知您`;
                    notifyStatus.style.color = "#10b981";
                    
                    // 測試發送
                    sendSystemNotification("通知已啟用", "當號碼接近時，我們會通知您！");
                } else {
                    alert("請輸入號碼");
                }
            } else {
                alert("您必須允許通知權限才能使用此功能");
            }
        });
    });
}

/* 9. 複製連結 (保持不變) */
function copyLink() {
    if (isCopying) return; 
    if (!navigator.clipboard) { alert("複製功能僅支援 HTTPS 安全連線。"); return; }
    navigator.clipboard.writeText(window.location.href).then(() => {
        isCopying = true;
        if (copyLinkPrompt) {
            copyLinkPrompt.innerHTML = '<span class="emoji">✅</span> 已複製！';
            copyLinkPrompt.classList.add("is-copied");
        }
        setTimeout(() => {
            if (copyLinkPrompt) {
                copyLinkPrompt.innerHTML = '<span class="emoji">🔗</span> 點此複製網頁連結';
                copyLinkPrompt.classList.remove("is-copied");
            }
            isCopying = false;
        }, 2000);
    }).catch(err => { alert("複製失敗，請手動複製網址。"); });
}
if (copyLinkPrompt) { copyLinkPrompt.addEventListener("click", copyLink); }

// 首次載入時，嘗試自動播放以取得權限
playNotificationSound();
