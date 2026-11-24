// Два сервера:
//  • панель управления — http://localhost:8790 (по умолчанию только с этого компьютера);
//  • вебхуки Meta — порт 8791: только приём сообщений WhatsApp (официальный) и Instagram. Его и открывают в интернет через ngrok.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ROOT, paths, config, patchConfig, publicConfig, stripMasked, log } from './config.mjs';
import { get, all, run, insert, update, addEvent, kvGet } from './db.mjs';
import * as hub from './channels/hub.mjs';
import * as waqr from './channels/wa-qr.mjs';
import { signatureOk, verifyChallenge, onWhatsAppWebhook, onInstagramWebhook } from './channels/meta.mjs';
import { PRESETS, testAi } from './ai/providers.mjs';
import { tunnelStatus } from './tunnel.mjs';
import { sendAsOwner, think } from './agent.mjs';
import { getContact, recentMessages, openRequest, setStage, deleteContact, STAGES, STAGE_LABEL, CHANNEL_LABEL } from './store.mjs';
import { listHotels, saveHotel, listKnowledge, saveKnowledge, deleteKnowledge } from './knowledge.mjs';
import {
  addLesson, setLessonStatus, editLesson, deleteLesson, correctMessage, answerQuestion, ownerChat,
  dailyReview, teachHistory, clearTeachHistory,
} from './learning.mjs';
import { stats, analyst, exportCsv, EXPORT_NAMES } from './analytics.mjs';
import { stageUpload, finishUpload, runStudy, studyStatus, saveProfile, deleteExample, fetchInstagramHistory } from './study.mjs';

const WEB = path.join(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp4': 'video/mp4' };

function readBody(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(data);
}

// ---------- защита панели ----------
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const sessionToken = () => crypto.createHmac('sha256', config().panel.password || 'none').update('wakil-panel').digest('hex');
function authed(req) {
  if (isLocal(req)) return true;
  const cfg = config().panel;
  if (!cfg.allowLan || !cfg.password) return false;
  const m = /(?:^|;\s*)wakil=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && m[1] === sessionToken();
}
/** Защита от чужих сайтов: адрес должен быть наш, а запросы на изменение — с особым заголовком. */
function hostOk(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
  if (!config().panel.allowLan) return false;
  return lanAddresses().includes(host) || /\.local$/.test(host);
}
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

// ---------- маршруты API ----------
const routes = [];
const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, ...opts });

route('GET', '/api/overview', () => {
  const cfg = config();
  return {
    business: cfg.business.name, agentName: cfg.business.agentName, botEnabled: cfg.behavior.botEnabled,
    ai: { provider: cfg.ai.provider, name: PRESETS[cfg.ai.provider]?.name || cfg.ai.provider, model: cfg.ai.model },
    channels: hub.statuses(),
    tunnel: tunnelStatus(),
    counts: {
      attention: get("SELECT COUNT(*) n FROM contacts WHERE attention = 1 AND channel != 'test'").n,
      claimed: get("SELECT COUNT(*) n FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.status = 'claimed' AND (c.channel IS NULL OR c.channel != 'test')").n,
      questions: get("SELECT COUNT(*) n FROM questions WHERE status = 'open'").n,
      proposals: get("SELECT COUNT(*) n FROM lessons WHERE status = 'proposed'").n,
      hotels: get('SELECT COUNT(*) n FROM hotels WHERE active = 1').n,
      lessons: get("SELECT COUNT(*) n FROM lessons WHERE status = 'active'").n,
      contacts: get("SELECT COUNT(*) n FROM contacts WHERE channel != 'test' AND imported = 0").n,
      archive: get('SELECT COUNT(*) n FROM contacts WHERE imported = 1').n,
    },
    events: all("SELECT * FROM events WHERE type IN ('notify','ai_limit','send_error') ORDER BY id DESC LIMIT 40").map((e) => ({ ...e, data: JSON.parse(e.data || '{}') })),
    lastReview: kvGet('last_review', null),
    aiLast: get('SELECT ok, error, at FROM ai_calls ORDER BY id DESC LIMIT 1') || null,
    ownerPhoneSet: String(cfg.business.ownerPhone || '').replace(/\D/g, '').length >= 7,
    tested: !!get("SELECT id FROM contacts WHERE channel = 'test' LIMIT 1") || !!get("SELECT id FROM ai_calls WHERE purpose = 'reply' AND ok = 1 LIMIT 1"),
    currency: cfg.business.currency,
    study: studyStatus(),
    knowledgeFilled: !listKnowledge().every((f) => /\[[^\]]+\]/.test(f.text)),
  };
});

route('GET', '/api/contacts', (q) => {
  const f = q.get('filter') || '';
  const where = ["c.channel != 'test'", f === 'archive' ? 'c.imported = 1' : 'c.imported = 0']; const params = [];
  if (f === 'attention') where.push('c.attention = 1');
  if (f === 'owner') where.push("(c.mode = 'owner' OR c.paused_until > ?)"), params.push(Date.now());
  if (STAGES.includes(f)) where.push('c.stage = ?'), params.push(f);
  const s = (q.get('q') || '').trim();
  if (s) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.username LIKE ? OR c.summary LIKE ? OR c.notes LIKE ?)'); for (let i = 0; i < 5; i++) params.push(`%${s}%`); }
  const rows = all(`SELECT c.*, (SELECT text FROM messages m WHERE m.contact_id = c.id ORDER BY m.at DESC, m.id DESC LIMIT 1) AS last_text,
      (SELECT author FROM messages m WHERE m.contact_id = c.id ORDER BY m.at DESC, m.id DESC LIMIT 1) AS last_author
    FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.attention DESC, c.last_at DESC LIMIT 300`, ...params);
  return rows.map((c) => ({ ...c, facts: undefined }));
});

route('GET', '/api/contacts/:id', (q, p) => {
  const c = getContact(Number(p.id));
  if (!c) throw httpError(404, 'Нет такого клиента');
  return {
    contact: { ...c, facts: JSON.parse(c.facts || '{}') },
    messages: recentMessages(c.id, 300),
    request: openRequest(c.id, false) || get('SELECT * FROM requests WHERE contact_id = ? ORDER BY id DESC LIMIT 1', c.id) || null,
    bookings: all('SELECT * FROM bookings WHERE contact_id = ? ORDER BY id DESC', c.id),
    payments: all('SELECT * FROM payments WHERE contact_id = ? ORDER BY id DESC', c.id),
  };
});

route('POST', '/api/contacts/:id', (q, p, b) => {
  const id = Number(p.id);
  const c = getContact(id);
  if (!c) throw httpError(404, 'Нет такого клиента');
  const patch = {};
  if (b.mode === 'bot' || b.mode === 'owner') patch.mode = b.mode;
  if (b.resume) patch.paused_until = 0;
  if (b.notes !== undefined) patch.notes = String(b.notes).slice(0, 3000);
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 100);
  if (b.attention === 0) { patch.attention = 0; patch.attention_reason = ''; }
  if (b.lost_reason !== undefined) patch.lost_reason = String(b.lost_reason).slice(0, 200);
  if (Object.keys(patch).length) update('contacts', id, patch);
  if (b.stage) setStage(id, b.stage, b.lost_reason);
  return { ok: true };
});
route('POST', '/api/contacts/:id/send', async (q, p, b) => {
  const text = String(b.text || '').trim();
  if (!text) throw httpError(400, 'Пустое сообщение');
  const r = await sendAsOwner(Number(p.id), text);
  if (!r.ok) throw httpError(400, r.error || 'Не отправилось');
  return { ok: true };
});
route('POST', '/api/contacts/:id/rethink', (q, p) => {
  const id = Number(p.id);
  update('contacts', id, { paused_until: 0 });
  think(id).catch((e) => log(e));
  return { ok: true };
});
route('POST', '/api/contacts/:id/delete', (q, p) => { deleteContact(Number(p.id)); return { ok: true }; });

route('POST', '/api/messages/:id/correct', async (q, p, b) => {
  if (!String(b.text || '').trim()) throw httpError(400, 'Напишите, как надо было ответить');
  await correctMessage(Number(p.id), String(b.text).trim(), String(b.why || '').trim());
  return { ok: true };
});

route('GET', '/api/media/:file', (q, p, b, res) => {
  const name = path.basename(decodeURIComponent(p.file));
  const file = path.join(paths.media, name);
  if (!fs.existsSync(file)) throw httpError(404, 'Нет файла');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(name)] || 'application/octet-stream');
  return undefined;
});

// отели и знания
route('GET', '/api/hotels', () => listHotels());
route('POST', '/api/hotels', (q, p, b) => ({ ok: true, id: saveHotel(b) }));
route('POST', '/api/hotels/:id/delete', (q, p) => { run('DELETE FROM hotels WHERE id = ?', Number(p.id)); return { ok: true }; });
route('GET', '/api/knowledge', () => listKnowledge());
route('POST', '/api/knowledge', (q, p, b) => {
  if (b.oldName && b.oldName !== b.name) deleteKnowledge(b.oldName);
  saveKnowledge(b.name, b.text); return { ok: true };
});
route('POST', '/api/knowledge/delete', (q, p, b) => { deleteKnowledge(b.name); return { ok: true }; });

// обучение
route('GET', '/api/learning', () => ({
  lessons: all("SELECT * FROM lessons WHERE status != 'rejected' ORDER BY status = 'proposed' DESC, id DESC"),
  questions: all("SELECT q.*, c.name, c.channel FROM questions q LEFT JOIN contacts c ON c.id = q.contact_id WHERE q.status = 'open' ORDER BY q.id DESC LIMIT 100"),
  history: teachHistory(),
  lastReview: kvGet('last_review', null),
  autoApprove: !!config().behavior.autoApproveLessons,
}));
route('POST', '/api/lessons', (q, p, b) => ({ ok: true, id: addLesson({ kind: b.kind || 'rule', text: b.text, source: 'owner' }) }));
route('POST', '/api/lessons/:id', (q, p, b) => {
  if (b.status) setLessonStatus(Number(p.id), b.status);
  if (b.text !== undefined) editLesson(Number(p.id), b.text);
  return { ok: true };
});
route('POST', '/api/lessons/:id/delete', (q, p) => { deleteLesson(Number(p.id)); return { ok: true }; });
route('POST', '/api/questions/:id', (q, p, b) => {
  if (b.ignore) run("UPDATE questions SET status = 'ignored' WHERE id = ?", Number(p.id));
  else answerQuestion(Number(p.id), String(b.answer || '').trim());
  return { ok: true };
});
route('POST', '/api/teach', async (q, p, b) => ownerChat(String(b.text || ''), { via: 'panel' }));
route('POST', '/api/teach/clear', () => { clearTeachHistory(); return { ok: true }; });
route('POST', '/api/review', async (q, p, b) => dailyReview({ hours: Number(b.hours) || 24, force: true }));

// изучение прошлой переписки
route('GET', '/api/study', () => ({ ...studyStatus(), profile: kvGet('style_profile', null), examples: kvGet('style_examples', []), ownerName: kvGet('export_owner_name', '') }));
route('POST', '/api/study/upload', (q, p, raw) => {
  const name = String(q.get('name') || 'file.txt');
  const batch = String(q.get('batch') || 'b');
  try { return { ok: true, ...stageUpload(batch, name, raw) }; } catch (e) { throw httpError(400, `${name}: ${e.message}`); }
}, { raw: true, limit: 80 * 1024 * 1024 });
route('POST', '/api/study/import', (q, p, b) => finishUpload(String(b.batch || 'b'), String(b.ownerName || '')));
route('POST', '/api/study/run', (q, p, b) => {
  runStudy({ mode: b.mode === 'update' ? 'update' : 'full' }).catch((e) => log('Изучение:', e));
  return { ok: true };
});
route('POST', '/api/study/profile', (q, p, b) => { saveProfile(b.text); return { ok: true }; });
route('POST', '/api/study/examples/:i/delete', (q, p) => { deleteExample(Number(p.i)); return { ok: true }; });
route('POST', '/api/study/instagram', async () => {
  const r = await fetchInstagramHistory();
  if (!r.ok) throw httpError(400, r.error);
  return r;
});

// брони и оплаты
const BOOKING_FIELDS = ['contact_id', 'hotel', 'city', 'check_in', 'check_out', 'nights', 'guests', 'rooms', 'room_type', 'total', 'currency', 'commission', 'status', 'note'];
route('GET', '/api/bookings', () => {
  const bookings = all(`SELECT b.*, c.name AS contact_name, c.channel, c.phone,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.booking_id = b.id AND p.status = 'confirmed') AS paid
    FROM bookings b LEFT JOIN contacts c ON c.id = b.contact_id ORDER BY b.id DESC LIMIT 500`);
  const payments = all(`SELECT p.*, c.name AS contact_name, c.channel FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE p.status != 'rejected' AND (c.channel IS NULL OR c.channel != 'test') ORDER BY p.status = 'claimed' DESC, p.id DESC LIMIT 500`);
  return { bookings, payments };
});
route('POST', '/api/bookings', (q, p, b) => {
  const row = {};
  for (const k of BOOKING_FIELDS) if (b[k] !== undefined) row[k] = b[k] === '' && ['nights', 'guests', 'rooms', 'contact_id'].includes(k) ? null : b[k];
  for (const k of ['total', 'commission']) if (row[k] !== undefined) row[k] = Number(row[k]) || 0;
  if (row.check_in && row.check_out && !row.nights) {
    const n = Math.round((Date.parse(row.check_out) - Date.parse(row.check_in)) / 86400000);
    if (n > 0) row.nights = n;
  }
  let id = Number(b.id) || 0;
  if (id) update('bookings', id, row);
  else {
    id = insert('bookings', { currency: config().business.currency, ...row, created_at: Date.now() });
    if (row.contact_id) {
      const req = openRequest(Number(row.contact_id), false);
      if (req) update('requests', req.id, { status: 'booked', updated_at: Date.now() });
      const c = getContact(Number(row.contact_id));
      if (c && STAGES.indexOf(c.stage) < STAGES.indexOf('booking')) setStage(c.id, 'booking');
    }
    addEvent('booking', row.contact_id || null, { id });
  }
  return { ok: true, id };
});
route('POST', '/api/bookings/:id/delete', (q, p) => { run('DELETE FROM bookings WHERE id = ?', Number(p.id)); run('UPDATE payments SET booking_id = NULL WHERE booking_id = ?', Number(p.id)); return { ok: true }; });
route('POST', '/api/payments', (q, p, b) => {
  const row = {};
  for (const k of ['booking_id', 'contact_id', 'amount', 'currency', 'method', 'status', 'note']) if (b[k] !== undefined) row[k] = b[k] === '' && /_id$/.test(k) ? null : b[k];
  if (row.amount !== undefined) row.amount = Number(row.amount) || 0;
  if (row.booking_id && !row.contact_id) row.contact_id = get('SELECT contact_id FROM bookings WHERE id = ?', Number(row.booking_id))?.contact_id ?? null;
  let id = Number(b.id) || 0;
  if (id) update('payments', id, row);
  else id = insert('payments', { currency: config().business.currency, status: 'confirmed', ...row, at: Date.now() });
  const pay = get('SELECT * FROM payments WHERE id = ?', id);
  if (pay.status === 'confirmed' && pay.contact_id) {
    if (!pay.booking_id) {
      const bk = get("SELECT id FROM bookings WHERE contact_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1", pay.contact_id);
      if (bk) update('payments', id, { booking_id: bk.id });
    }
    setStage(pay.contact_id, 'paid');
  }
  return { ok: true, id };
});
route('POST', '/api/payments/:id/delete', (q, p) => { run('DELETE FROM payments WHERE id = ?', Number(p.id)); return { ok: true }; });

// аналитика
route('GET', '/api/stats', (q) => stats(Number(q.get('days') ?? 30)));
route('POST', '/api/analyst', async (q, p, b) => analyst(String(b.question || ''), Number(b.days ?? 90)));
route('GET', '/api/export/:name', (q, p, b, res) => {
  const name = String(p.name).replace(/\.csv$/, '');
  if (!EXPORT_NAMES.includes(name)) throw httpError(404, 'Нет такой выгрузки');
  send(res, 200, exportCsv(name), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="wakil-${name}-${new Date().toISOString().slice(0, 10)}.csv"` });
  return undefined;
});

// настройки и подключения
route('GET', '/api/settings', () => ({
  config: publicConfig(), presets: PRESETS, stages: STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s] })), channelLabels: CHANNEL_LABEL,
  lan: lanAddresses(), platform: process.platform,
}));
route('POST', '/api/settings', (q, p, b) => {
  const patch = stripMasked(b || {});
  if (patch.panel?.password) patch.panel.password = String(patch.panel.password);
  patchConfig(patch);
  return { ok: true, config: publicConfig() };
});
route('POST', '/api/ai/test', async () => testAi());
route('POST', '/api/waqr/start', async () => { patchConfig({ channels: { waQr: { enabled: true } } }); return { ok: true }; });
route('POST', '/api/waqr/stop', async () => { patchConfig({ channels: { waQr: { enabled: false } } }); return { ok: true }; });
route('POST', '/api/waqr/logout', async () => { await waqr.logout(); patchConfig({ channels: { waQr: { enabled: false } } }); return { ok: true }; });

// проверочный чат: владелец пишет как клиент
const TEST_CHAT = 'panel-test';
route('POST', '/api/test/send', (q, p, b) => {
  const text = String(b.text || '').trim();
  if (!text) throw httpError(400, 'Пустое сообщение');
  hub.inbound({ channel: 'test', chatId: TEST_CHAT, name: 'Проверка', text, extId: 't' + Date.now() + Math.random().toString(36).slice(2, 6), at: Date.now() });
  return { ok: true };
});
route('GET', '/api/test', () => {
  const c = get("SELECT * FROM contacts WHERE channel = 'test' AND chat_id = ?", TEST_CHAT);
  return { contact: c ? { ...c, facts: JSON.parse(c.facts || '{}') } : null, messages: c ? recentMessages(c.id, 200) : [], request: c ? openRequest(c.id, false) : null };
});
route('POST', '/api/test/reset', () => {
  const c = get("SELECT id FROM contacts WHERE channel = 'test' AND chat_id = ?", TEST_CHAT);
  if (c) deleteContact(c.id);
  return { ok: true };
});

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- панель ----------
async function handlePanel(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!hostOk(req)) return send(res, 403, { error: 'Неизвестный адрес' });
  // вход по паролю (только если разрешён доступ из локальной сети)
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)).toString() || '{}');
    const pw = config().panel.password;
    if (pw && b.password === pw) return send(res, 200, { ok: true }, undefined, { 'set-cookie': `wakil=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    return send(res, 401, { error: 'Неверный пароль' });
  }
  if (url.pathname.startsWith('/api/')) {
    if (!authed(req)) return send(res, 401, { error: 'Нужен вход', login: true });
    if (req.method !== 'GET' && req.headers['x-wakil'] !== '1') return send(res, 403, { error: 'Запрос отклонён' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      try {
        let body = {};
        if (req.method === 'POST') {
          const raw = await readBody(req, r.limit || 3 * 1024 * 1024);
          body = r.raw ? raw : raw.length ? JSON.parse(raw.toString()) : {};
        }
        const out = await r.fn(url.searchParams, m.groups || {}, body, res);
        if (out !== undefined) send(res, 200, out);
      } catch (e) {
        if (!e.status) log('Панель:', req.method, url.pathname, e);
        if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      }
      return;
    }
    return send(res, 404, { error: 'Нет такого действия' });
  }
  // файлы панели
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(path.join(WEB, file));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
  const isLogin = !authed(req);
  if (isLogin && path.basename(file) === 'index.html') {
    return send(res, 200, fs.readFileSync(file, 'utf8').replace('<body>', '<body data-login="1">'), TYPES['.html']);
  }
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

// ---------- вебхуки Meta ----------
async function handleWebhook(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const channel = url.pathname === '/webhook/whatsapp' ? 'wacloud' : url.pathname === '/webhook/instagram' ? 'instagram' : null;
  if (!channel) return send(res, 404, 'not found', 'text/plain');
  if (req.method === 'GET') {
    const ch = verifyChallenge(channel, url.searchParams);
    return ch === null ? send(res, 403, 'forbidden', 'text/plain') : send(res, 200, ch, 'text/plain');
  }
  if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
  let raw;
  try { raw = await readBody(req, 5 * 1024 * 1024); } catch { return send(res, 413, 'too large', 'text/plain'); }
  const secret = channel === 'wacloud' ? config().channels.waCloud.appSecret : config().channels.instagram.appSecret;
  if (!signatureOk(raw, req.headers['x-hub-signature-256'], secret)) { log('Вебхук: неверная подпись', channel); return send(res, 401, 'bad signature', 'text/plain'); }
  // Meta ждёт ответ быстро — отвечаем сразу, а сообщение обрабатываем следом
  send(res, 200, 'EVENT_RECEIVED', 'text/plain');
  let body;
  try { body = JSON.parse(raw.toString()); } catch { return; }
  (channel === 'wacloud' ? onWhatsAppWebhook(body) : onInstagramWebhook(body)).catch((e) => log('Вебхук', channel, e));
}

export function startServers() {
  const cfg = config().panel;
  const panel = http.createServer((req, res) => handlePanel(req, res).catch((e) => { log('Панель:', e); if (!res.headersSent) send(res, 500, { error: e.message }); }));
  const host = cfg.allowLan && cfg.password ? '0.0.0.0' : '127.0.0.1';
  panel.listen(cfg.port, host, () => log(`Панель: http://localhost:${cfg.port}${host === '0.0.0.0' ? ' (и из локальной сети: ' + lanAddresses().map((a) => `http://${a}:${cfg.port}`).join(', ') + ')' : ''}`));
  const hooks = http.createServer((req, res) => handleWebhook(req, res).catch((e) => { log('Вебхук:', e); if (!res.headersSent) send(res, 500, 'error', 'text/plain'); }));
  hooks.listen(cfg.webhookPort, '127.0.0.1', () => log(`Вебхуки Meta: http://localhost:${cfg.webhookPort}/webhook/whatsapp и /webhook/instagram`));
  for (const [name, srv, port] of [['Панель', panel, cfg.port], ['Вебхуки', hooks, cfg.webhookPort]]) {
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE') { log(`${name}: порт ${port} занят — Вакиль уже запущен? Закройте другое окно или смените порт в data/config.json.`); process.exit(1); }
      log(name, e);
    });
  }
  return { panel, hooks, ready: Promise.all([panel, hooks].map((srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r))))) };
}

