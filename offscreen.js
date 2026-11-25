// Lens AI: Swin v3 (int8, ตัด 5 ตำแหน่ง) + CLIP-B/16 (int8, ตัดกลางภาพ) ผ่าน onnxruntime-web
const CFG = {
    swinUrl: chrome.runtime.getURL('models/swin_v3_int8.onnx'),
    clipUrl: chrome.runtime.getURL('models/clip_b16_int8.onnx'),
    headUrl: chrome.runtime.getURL('models/clipb_head.json'),
    swinMean: [0.485, 0.456, 0.406], swinStd: [0.229, 0.224, 0.225],
    clipMean: [0.48145466, 0.4578275, 0.40821073], clipStd: [0.26862954, 0.26130258, 0.27577711],
    swinFakeIndex: 0,          // Swin v3: 0 = fake, 1 = real
    T_AI: 0.62,                // ≥ นี้ = "ไม่แน่ใจ (อาจเป็น AI)" (เกณฑ์จากภาพจริง val ที่ FPR ราว 10%)
    T_HIGH: 0.74,              // ≥ นี้ = "น่าจะเป็น AI" (FPR ราว 5%)
    MAX_PIXELS: 120e6,         // กันภาพใหญ่เกินจนแรมเต็ม
    MODEL_VERSION: 'swinv3-int8+clipb-int8-head1',  // เปลี่ยนชื่อนี้ทุกครั้งที่เปลี่ยนโมเดลหรือหัวจำแนก (ใช้บันทึกคู่กับภาพที่รายงาน)
    MIN_SIDE: 512,             // ด้านสั้นน้อยกว่านี้ = สรุปไม่ได้ (เกณฑ์ที่ผมตั้งเอง ไม่ได้วัด)
};
const POS = [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75]];
let engine = null;
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((message) => {
    if (message.target === 'offscreen' && message.imageUrl) {
        queue = queue.then(() => runAIProcessor(message.imageUrl));
    }
});
chrome.runtime.sendMessage({ target: 'background', action: 'offscreen-ready' });

async function loadEngine() {
    if (engine) return engine;
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const bytes = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    console.log('📍 โหลดโมเดล Swin...');
    const swin = await ort.InferenceSession.create(await bytes(CFG.swinUrl), opts);
    console.log('📍 โหลดโมเดล CLIP-B...');
    const clip = await ort.InferenceSession.create(await bytes(CFG.clipUrl), opts);
    const head = await (await fetch(CFG.headUrl)).json();
    engine = { swin, clip, w: Float32Array.from(head.w), b: head.b };
    return engine;
}

// ตัดพื้นที่ 224x224 (พิกเซลต้นฉบับ ไม่ย่อ) ลงบนพื้นขาว แล้วทำเป็น tensor NCHW
const cropCanvas = new OffscreenCanvas(224, 224);
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
function cropTensor(src, l, t, mean, std) {
    cropCtx.fillStyle = '#fff';
    cropCtx.fillRect(0, 0, 224, 224);
    cropCtx.drawImage(src, l, t, 224, 224, 0, 0, 224, 224);
    const { data } = cropCtx.getImageData(0, 0, 224, 224);
    const n = 224 * 224, out = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
        out[i] = (data[4 * i] / 255 - mean[0]) / std[0];
        out[n + i] = (data[4 * i + 1] / 255 - mean[1]) / std[1];
        out[2 * n + i] = (data[4 * i + 2] / 255 - mean[2]) / std[2];
    }
    return new ort.Tensor('float32', out, [1, 3, 224, 224]);
}

// ภาพที่ด้านสั้นน้อยกว่า 224: ขยายให้ด้านสั้น = 224 (เหมือนฝั่ง Python)
function prepareSource(bmp) {
    let w = bmp.width, h = bmp.height;
    if (Math.min(w, h) >= 224) return { src: bmp, w, h };
    const s = 224 / Math.min(w, h);
    const W = Math.max(224, Math.round(w * s)), H = Math.max(224, Math.round(h * s));
    const c = new OffscreenCanvas(W, H), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, 0, 0, W, H);
    return { src: c, w: W, h: H };
}

async function analyze(imageUrl) {
    const t0 = performance.now();
    const eng = await loadEngine();
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`ดึงรูปไม่สำเร็จ (HTTP ${resp.status})`);
    const bmp = await createImageBitmap(await resp.blob(), { imageOrientation: 'from-image' });
    try {
        const origW = bmp.width, origH = bmp.height;
        if (origW * origH > CFG.MAX_PIXELS) throw new Error(`รูปใหญ่เกินไป (${origW}x${origH})`);
        const { src, w, h } = prepareSource(bmp);

        // Swin: 5 ตำแหน่ง เฉลี่ยความน่าจะเป็นของ fake
        let sum = 0;
        for (const [fx, fy] of POS) {
            const l = Math.floor((w - 224) * fx), t = Math.floor((h - 224) * fy);
            const out = await eng.swin.run({ pixel_values: cropTensor(src, l, t, CFG.swinMean, CFG.swinStd) });
            const lg = out[Object.keys(out)[0]].data;
            const e = [Math.exp(lg[0]), Math.exp(lg[1])];
            sum += e[CFG.swinFakeIndex] / (e[0] + e[1]);
        }
        const pSwin = sum / POS.length;

        // CLIP-B: ตัดกลางภาพ -> เวกเตอร์ 512 ค่า -> หัวจำแนก (sigmoid)
        const lc = Math.floor((w - 224) / 2), tc = Math.floor((h - 224) / 2);
        const o2 = await eng.clip.run({ pixel_values: cropTensor(src, lc, tc, CFG.clipMean, CFG.clipStd) });
        const f = o2[Object.keys(o2)[0]].data;
        let z = eng.b;
        for (let i = 0; i < eng.w.length; i++) z += eng.w[i] * f[i];
        const pClip = 1 / (1 + Math.exp(-z));

        const p = (pSwin + pClip) / 2;
        const isAI = p >= CFG.T_AI;
        return {
            label: isAI ? 'artificial' : 'human',   // คงชื่อเดิมให้ background.js ใช้ได้
            score: isAI ? p : 1 - p,
            p_fake: p, p_swin: pSwin, p_clip: pClip,
            level: Math.min(origW, origH) < CFG.MIN_SIDE ? 'inconclusive'
                 : (p >= CFG.T_HIGH ? 'likely_ai' : (isAI ? 'uncertain' : 'no_evidence')),
            width: origW, height: origH, ms: Math.round(performance.now() - t0),
            t_ai: CFG.T_AI, t_high: CFG.T_HIGH, model_version: CFG.MODEL_VERSION,
        };
    } finally {
        bmp.close();
    }
}

async function runAIProcessor(imageUrl) {
    try {
        console.log('📍 เริ่มวิเคราะห์:', imageUrl);
        const result = await analyze(imageUrl);
        result.imageUrl = imageUrl;   // ให้ background จับคู่ผลกับบริบทของภาพ
        console.log('📍 ผลลัพธ์:', result);
        chrome.runtime.sendMessage({ target: 'background', action: 'detection-result', result });
    } catch (error) {
        console.error('❌ Offscreen Error:', error);
        chrome.runtime.sendMessage({ target: 'background', action: 'detection-error',
                                     error: error.message || String(error) });
    }
} 
// โหมดทดสอบแบบกลุ่ม: เรียกจาก console ของหน้า offscreen
async function runBatch(listUrl, resultsUrl, onlyIds = null) {
    const all = await (await fetch(listUrl)).json();
    const list = onlyIds ? all.filter(it => onlyIds.includes(it.id)) : all;
    const out = [];
    for (const it of list) {
        let r = null, lastErr = null;
        for (let k = 0; k < 3 && !r; k++) {
            try { r = await analyze(it.url); }
            catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 800 * (k + 1))); }
        }
        out.push(r ? { id: it.id, p_swin: r.p_swin, p_clip: r.p_clip, p_fake: r.p_fake,
                       w: r.width, h: r.height, ms: r.ms }
                   : { id: it.id, error: String(lastErr) });
        if (out.length % 50 === 0) console.log(`${out.length}/${list.length}`);
    }
    await fetch(resultsUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(out) });
    console.log('เสร็จแล้ว ส่งผลกลับเซิร์ฟเวอร์ ภาพที่ยัง error:', out.filter(o => o.error).length);
}
globalThis.runBatch = runBatch;