// ---------- ส่วนเดิม: เตรียม URL ----------
let urlNote = "";
// ฟังก์ชันบริสุทธิ์ (ไม่แตะตัวแปรร่วม) ใช้ได้ทั้งตอนวิเคราะห์และตอนบันทึกภาพ
function upgradeUrl(u) {
    let note = "";
    try {
        const url = new URL(u);
        if (url.hostname === "pbs.twimg.com" && url.searchParams.has("name")) {
            url.searchParams.set("name", "orig");      // ลองขอไฟล์ต้นฉบับ (ยังไม่ได้ตรวจว่าใช้ได้)
            return { url: url.toString(), note };
        }
        if (/gstatic\.com$/.test(url.hostname) || u.includes("encrypted-tbn")) {
            note = "\nThumbnail from Google Images: open the original image";
        }
    } catch (e) {}
    return { url: u, note };
}
function prepareUrl(u) {
    const r = upgradeUrl(u);
    urlNote = r.note;
    return r.url;
}
let pendingImageUrl = null;
let creatingOffscreen;
const NOTIFY_ID = "verilens-status";
const MENU_DETECT = "detect-ai";
const MENU_SAVE = "save-dataset";
const ctxKey = (u) => "ctx:" + u;

// 🌟 1. ฟังก์ชันท่าไม้ตาย: บังคับเด้งแจ้งเตือนใหม่ทุกครั้ง! (เพิ่มพารามิเตอร์ปุ่ม)
function forceShowNotification(title, message, iconUrl = "https://cdn-icons-png.flaticon.com/512/868/868910.png", buttons = null) {
    chrome.notifications.clear(NOTIFY_ID, () => {
        const opts = { type: "basic", iconUrl: iconUrl, title: title, message: message };
        if (buttons) opts.buttons = buttons;
        chrome.notifications.create(NOTIFY_ID, opts);
    });
}

async function setupOffscreen() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;

    if (creatingOffscreen) {
        await creatingOffscreen;
        return;
    }

    creatingOffscreen = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run AI model safely'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: MENU_DETECT, title: "Lens Ai", contexts: ["all"] });
        chrome.contextMenus.create({ id: MENU_SAVE, title: "Lens Ai: save image to dataset (give label)", contexts: ["all"] });
    });
});

// ---------- ส่วนใหม่: เปิดหน้าต่างบันทึกภาพเข้าชุดข้อมูล ----------
async function openReportWindow(d) {
    const key = "draft:" + Date.now();
    await chrome.storage.session.set({ [key]: d });
    chrome.windows.create({
        url: chrome.runtime.getURL("report.html") + "?k=" + encodeURIComponent(key),
        type: "popup", width: 540, height: 820
    });
}

async function getClickedImageUrl(info, tab) {
    let u = info.srcUrl || null;
    try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "getImageUrl" });
        if (response && response.url) u = response.url;
    } catch (e) {}
    return u;
}

async function openReportFromClick(info, tab) {
    const imgUrl = await getClickedImageUrl(info, tab);
    if (!imgUrl) {
        forceShowNotification("Lens Ai Error", "Unable to extract image or invalid click target.", "https://cdn-icons-png.flaticon.com/512/564/564619.png");
        return;
    }
    const { lastAnalysis } = await chrome.storage.session.get("lastAnalysis");
    const same = lastAnalysis && lastAnalysis.ctx &&
        [lastAnalysis.ctx.analyzed_url, lastAnalysis.ctx.src_url].some(x => x && (x === imgUrl || x === info.srcUrl));
    await openReportWindow({
        image_url: same ? lastAnalysis.ctx.analyzed_url : upgradeUrl(imgUrl).url,
        src_url: imgUrl,
        page_url: (tab && tab.url) || info.pageUrl || null,
        model: same ? lastAnalysis.result : null,     // null = ยังไม่เคยวิเคราะห์ภาพนี้
    });
}

async function openReportFromLast() {
    const { lastAnalysis } = await chrome.storage.session.get("lastAnalysis");
    if (!lastAnalysis) return;
    await openReportWindow({
        image_url: lastAnalysis.ctx.analyzed_url,
        src_url: lastAnalysis.ctx.src_url || lastAnalysis.ctx.analyzed_url,
        page_url: lastAnalysis.ctx.page_url || null,
        model: lastAnalysis.result,
    });
}

async function saveLast(r) {
    const k = ctxKey(r.imageUrl);
    const ctx = (await chrome.storage.session.get(k))[k] || { analyzed_url: r.imageUrl };
    await chrome.storage.session.set({ lastAnalysis: { ctx, result: r } });
}

chrome.contextMenus.onClicked.addListener(async(info, tab) => {
    if (info.menuItemId === MENU_SAVE) {
        await openReportFromClick(info, tab);
        return;
    }
    if (info.menuItemId === MENU_DETECT) {

        let targetUrl = info.srcUrl;

        if (targetUrl) {
            targetUrl = prepareUrl(targetUrl);
            try {
                const response = await chrome.tabs.sendMessage(tab.id, { action: "getImageUrl" });
                if (response && response.url) targetUrl = response.url;
            } catch (e) {}
        }

        if (targetUrl) {
            // จำบริบทของภาพนี้ไว้ เพื่อใช้ตอนกดบันทึก (หมดอายุเมื่อปิดเบราว์เซอร์)
            await chrome.storage.session.set({ [ctxKey(targetUrl)]: {
                analyzed_url: targetUrl, src_url: info.srcUrl || null,
                page_url: (tab && tab.url) || info.pageUrl || null, ts: Date.now()
            } });

            // 🌟 2. ใช้ฟังก์ชันใหม่ เรียกแจ้งเตือน "กำลังประมวลผล"
            forceShowNotification("Lens Ai", "Analyzing image...");

            const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });

            if (contexts.length > 0) {
                chrome.runtime.sendMessage({ target: 'offscreen', imageUrl: targetUrl })
                    .catch(err => console.log("ส่งพลาด:", err));
            } else {
                pendingImageUrl = targetUrl;
                await setupOffscreen();
            }
        } else {
            // 🌟 3. แจ้งเตือน Error กรณีหารูปไม่เจอ (เปลี่ยนเป็นภาษาอังกฤษ)
            forceShowNotification("Lens Ai Error", "Unable to extract image or invalid click target.", "https://cdn-icons-png.flaticon.com/512/564/564619.png");
        }
    }
});

// ปุ่มบนการแจ้งเตือนผล (Windows ใช้ได้ถ้าไม่ได้ปิดแจ้งเตือนไว้) และคลิกตัวแจ้งเตือนเอง
chrome.notifications.onButtonClicked.addListener((id, idx) => {
    if (id === NOTIFY_ID && idx === 0) { chrome.notifications.clear(id); openReportFromLast(); }
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.target === 'background') {

        if (message.action === 'offscreen-ready') {
            if (pendingImageUrl) {
                chrome.runtime.sendMessage({ target: 'offscreen', imageUrl: pendingImageUrl });
                pendingImageUrl = null;
            }
        } else if (message.action === 'detection-result') {
            const r = message.result;
            saveLast(r);
            const levelText = {
                likely_ai: "Likely AI-generated",
                uncertain: "Uncertain (possible AI)",
                no_evidence: "No AI signal found (not proof it is real)",
                inconclusive: "Inconclusive: low-resolution image"
            }[r.level] || "Result";

            let msg = `${levelText}\nAI score: ${(r.p_fake * 100).toFixed(0)}%` + urlNote;
            if (r.width && r.height) {
                msg += `  |  ${r.width}x${r.height}px, ${(r.ms / 1000).toFixed(1)}s`;
                if (Math.min(r.width, r.height) < 224) {
                    msg += "\nVery small image: result unreliable";
                }
            }
            forceShowNotification("Analysis Complete", msg, undefined, [{ title: "Wrong? Save to dataset" }]);
        } else if (message.action === 'detection-error') {
            // 🌟 5. แจ้งเตือน Error ของระบบ AI
            forceShowNotification("Analysis Failed", message.error, "https://cdn-icons-png.flaticon.com/512/564/564619.png");
        }
    }
});
