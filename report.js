// Lens AI: บันทึกภาพ + ป้ายกำกับลงโฟลเดอร์ Downloads/LensAI_reports/ (ไม่ส่งข้อมูลออกนอกเครื่อง)
const FOLDER = 'LensAI_reports';
const SCHEMA = 1;
// เว็บที่ไม่ควรเก็บภาพจาก (แชต / อีเมล / บริการส่วนตัว) แก้รายการนี้ได้
const BLOCK_HOSTS = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'web.whatsapp.com',
    'messenger.com', 'web.telegram.org', 'line.me', 'drive.google.com', 'photos.google.com'];

const $ = (id) => document.getElementById(id);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const isBlocked = (u) => { const h = hostOf(u); return !!h && BLOCK_HOSTS.some(b => h === b || h.endsWith('.' + b)); };
// ตัด query/hash ออก กันโทเค็นหรือข้อมูลส่วนตัวใน URL
function strip(u) {
    if (!u) return null;
    if (u.startsWith('data:') || u.startsWith('blob:')) return u.split(':')[0] + ':';
    try { const x = new URL(u); return x.origin + x.pathname; } catch { return null; }
}
function extFor(mime) {
    return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
              'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' })[mime] || 'bin';
}
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// dHash 64 บิต (ไว้จับภาพซ้ำที่ถูกย่อ/บีบอัดใหม่) ย่อสองขั้นเพื่อลด aliasing
async function dHash(bmp) {
    const mid = document.createElement('canvas'); mid.width = 64; mid.height = 64;
    const mx = mid.getContext('2d'); mx.imageSmoothingQuality = 'high'; mx.drawImage(bmp, 0, 0, 64, 64);
    const c = document.createElement('canvas'); c.width = 9; c.height = 8;
    const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high';
    x.drawImage(mid, 0, 0, 9, 8);
    const d = x.getImageData(0, 0, 9, 8).data;
    const g = (i) => 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
    let bits = '';
    for (let y = 0; y < 8; y++) for (let k = 0; k < 8; k++) bits += g(y * 9 + k) > g(y * 9 + k + 1) ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
}
async function fetchImage(urls) {
    let lastErr = null;
    for (const u of [...new Set(urls.filter(Boolean))]) {
        try {
            const r = await fetch(u);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            if (!blob.size) throw new Error('ไฟล์ว่าง');
            await createImageBitmap(blob);   // ตรวจว่าเป็นภาพจริง
            return { blob, usedUrl: u, error: null };
        } catch (e) { lastErr = e; }
    }
    return { blob: null, usedUrl: null, error: String(lastErr || 'ไม่มี URL') };
}
// รอจนไฟล์ดาวน์โหลดเสร็จจริง (หรือถูกยกเลิก) ไม่ใช่แค่เบราว์เซอร์รับคำสั่ง
function waitDownload(id) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => { if (settled) return; settled = true; chrome.downloads.onChanged.removeListener(onChg); resolve(r); };
        const onChg = (d) => {
            if (d.id !== id || !d.state) return;
            if (d.state.current === 'complete') finish({ ok: true });
            else if (d.state.current === 'interrupted') finish({ ok: false, error: (d.error && d.error.current) || 'INTERRUPTED' });
        };
        chrome.downloads.onChanged.addListener(onChg);
        chrome.downloads.search({ id }, (items) => {          // กันกรณีเสร็จไปก่อนที่เราเริ่มฟัง
            const it = items && items[0];
            if (it && it.state === 'complete') finish({ ok: true });
            else if (it && it.state === 'interrupted') finish({ ok: false, error: it.error || 'INTERRUPTED' });
        });
    });
}
async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
        const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
        if (id === undefined) throw new Error('เบราว์เซอร์ไม่รับคำสั่งดาวน์โหลด');
        const r = await waitDownload(id);
        if (!r.ok) throw new Error(r.error === 'USER_CANCELED' ? 'ยกเลิกการบันทึกไฟล์' : 'ดาวน์โหลดล้มเหลว: ' + r.error);
        return id;
    } finally { URL.revokeObjectURL(url); }
}
function show(el, cls, text) { el.className = 'notice ' + cls; el.textContent = text; }

(async function main() {
    const key = new URLSearchParams(location.search).get('k');
    const draft = key ? (await chrome.storage.session.get(key))[key] : null;
    if (!draft) { $('meta').textContent = 'ไม่พบข้อมูลภาพ (เปิดหน้านี้จากเมนูคลิกขวาบนภาพ)'; $('form').classList.add('hidden'); return; }

    const m = draft.model;
    $('meta').innerHTML = (m
        ? `ระบบให้ <b>${(m.p_fake * 100).toFixed(0)}%</b> (${m.level}) · ${m.width}×${m.height}px<br>`
        : 'ภาพนี้ยังไม่เคยถูกวิเคราะห์ในรอบนี้ (จะบันทึกโดยไม่มีคะแนน)<br>')
        + `จาก ${hostOf(draft.page_url) || 'ไม่ทราบเว็บ'}`;

    $('reporter').value = (await chrome.storage.local.get('reporter')).reporter || '';

    const blockedHost = isBlocked(draft.page_url) || isBlocked(draft.image_url);
    if (blockedHost) {
        show($('blocked'), 'bad', `ไม่บันทึกภาพจาก ${hostOf(draft.page_url) || hostOf(draft.image_url)} เพราะเป็นบริการส่วนตัว (แก้รายการ BLOCK_HOSTS ใน report.js ได้)`);
        $('blocked').classList.remove('hidden');
        $('saveBtn').disabled = true;
    }

    const img = await fetchImage([draft.image_url, draft.src_url]);
    if (img.blob) $('thumb').src = URL.createObjectURL(img.blob);
    else {
        show($('fetchFail'), 'warn', 'ดึงไฟล์ภาพไม่ได้ (' + img.error + ') จะบันทึกเฉพาะข้อมูลและป้ายกำกับ ถ้าเป็นภาพสำคัญให้ "บันทึกภาพเป็น…" เก็บไว้เอง');
        $('fetchFail').classList.remove('hidden');
    }

    $('source').addEventListener('change', () => {
        const v = $('source').value;
        $('srcHint').textContent = v === 'guess'
            ? 'ป้ายแบบนี้จะถูกแยกไว้ ไม่ใช้เทรนหรือวัดผล (ใช้ดูรูปแบบความผิดพลาดเท่านั้น)' : '';
    });
    $('cancelBtn').addEventListener('click', () => window.close());

    $('form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (blockedHost) return;
        const label = (document.querySelector('input[name=label]:checked') || {}).value;
        const source = $('source').value;
        const st = $('status');
        if (!label) return show(st, 'bad', 'เลือกก่อนว่าภาพนี้จริงๆ เป็นอะไร'), st.classList.remove('hidden');
        if (label !== 'unsure' && !source) return show(st, 'bad', 'เลือกที่มาของป้ายด้วย'), st.classList.remove('hidden');
        $('saveBtn').disabled = true;
        show(st, 'warn', 'กำลังบันทึก… ถ้ามีหน้าต่างถามที่เก็บไฟล์ ให้กด Save (ภาพ 1 ครั้ง และไฟล์ข้อมูลอีก 1 ครั้ง) อย่าปิดหน้าต่างนี้'); st.classList.remove('hidden');

        try {
            const reporter = $('reporter').value.trim().slice(0, 30);
            await chrome.storage.local.set({ reporter });
            const now = new Date();
            let image = { saved: false, file: null, fetch_error: img.error };
            let sha = null, id;
            if (img.blob) {
                const buf = await img.blob.arrayBuffer();
                sha = await sha256Hex(buf);
                const bmp = await createImageBitmap(img.blob);
                const dh = await dHash(bmp);
                const ext = extFor(img.blob.type);
                id = `${stamp(now)}_${sha.slice(0, 12)}`;
                image = { saved: true, file: `${id}.${ext}`, sha256: sha, dhash: dh, mime: img.blob.type,
                          bytes: img.blob.size, width: bmp.width, height: bmp.height, fetch_error: null };
                bmp.close();
                await downloadBlob(img.blob, `${FOLDER}/${image.file}`);
            } else {
                id = `${stamp(now)}_nofile_${Math.random().toString(36).slice(2, 8)}`;
            }
            const trust = label === 'unsure' ? 'none' : (source === 'guess' ? 'weak' : 'strong');
            const record = {
                schema: SCHEMA, id, saved_at: now.toISOString(), reporter,
                label, source: source || null, label_trust: trust, note: $('note').value.trim() || null,
                image,
                context: { page_host: hostOf(draft.page_url) || null, page_url: strip(draft.page_url),
                           image_host: hostOf(draft.image_url) || null, image_url: strip(draft.image_url),
                           src_url: strip(draft.src_url), fetched_from: strip(img.usedUrl) },
                model: m ? { version: m.model_version || null, p_fake: m.p_fake, p_swin: m.p_swin, p_clip: m.p_clip,
                             level: m.level, t_ai: m.t_ai ?? null, t_high: m.t_high ?? null,
                             analyzed_w: m.width, analyzed_h: m.height, ms: m.ms } : null,
            };
            await downloadBlob(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }), `${FOLDER}/${id}.json`);
            show(st, 'ok', `บันทึกแล้ว: Downloads/${FOLDER}/${id}` + (trust === 'weak' ? ' (ป้ายแบบเดา: จะถูกแยกไว้)' : ''));
            st.classList.remove('hidden');
            setTimeout(() => window.close(), 1800);
        } catch (e) {
            show(st, 'bad', 'บันทึกไม่สำเร็จ: ' + (e && e.message || e));
            st.classList.remove('hidden');
            $('saveBtn').disabled = false;
        }
    });
})();