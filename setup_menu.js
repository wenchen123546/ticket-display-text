/*
 * setup_menus.js - 自動建立「民眾版」與「管理員版」選單
 * 執行指令：node setup_menus.js
 */
const line = require('@line/bot-sdk');
const fs = require('fs');
require('dotenv').config();

const client = new line.Client({
    channelAccessToken: process.env.LINE_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
});

async function main() {
    try {
        console.log("🚀 開始設定 Rich Menus...");

        // ==========================================
        // 1. 建立「民眾版 (預設)」選單
        // ==========================================
        console.log("\n[1/4] 正在建立民眾版選單 (Public Menu)...");
        const publicMenuId = await client.createRichMenu({
            size: { width: 2500, height: 1686 },
            selected: true,
            name: "Public Menu",
            chatBarText: "叫號服務",
            areas: [
                { // 左半邊按鈕：查詢進度
                    bounds: { x: 0, y: 0, width: 1250, height: 1686 },
                    action: { type: "message", text: "查詢進度" }
                },
                { // 右半邊按鈕：過號名單
                    bounds: { x: 1250, y: 0, width: 1250, height: 1686 },
                    action: { type: "message", text: "過號名單" }
                }
            ]
        });
        console.log(`- ID: ${publicMenuId}`);
        
        console.log("- 上傳圖片 menu_public.jpg ...");
        await client.setRichMenuImage(publicMenuId, fs.createReadStream('./menu_public.jpg'));
        
        console.log("- 設定為「預設選單」(所有新使用者都會看到這個)");
        await client.setDefaultRichMenu(publicMenuId);


        // ==========================================
        // 2. 建立「管理員版」選單
        // ==========================================
        console.log("\n[2/4] 正在建立管理員版選單 (Admin Menu)...");
        const adminMenuId = await client.createRichMenu({
            size: { width: 2500, height: 1686 },
            selected: true,
            name: "Admin Menu",
            chatBarText: "後台操作",
            areas: [
                { // 整個版面點擊：登出
                  // 對應 index.js 裡的 logic: if (text === '!logout' || text === '登出')
                    bounds: { x: 0, y: 0, width: 2500, height: 1686 },
                    action: { type: "message", text: "!logout" }
                }
            ]
        });
        console.log(`- ID: ${adminMenuId}`);

        console.log("- 上傳圖片 menu_admin.jpg ...");
        await client.setRichMenuImage(adminMenuId, fs.createReadStream('./menu_admin.jpg'));


        // ==========================================
        // 3. 輸出結果
        // ==========================================
        console.log("\n✅ 設定完成！");
        console.log("==================================================");
        console.log("請將下方的 ID 複製並更新到您的 .env 檔案中：");
        console.log(`ADMIN_RICH_MENU_ID=${adminMenuId}`);
        console.log("==================================================");

    } catch (e) {
        console.error("❌ 錯誤:", e.originalError?.response?.data || e.message);
        console.log("請確認目錄下是否有 menu_public.jpg 和 menu_admin.jpg 圖片檔案");
    }
}

main();