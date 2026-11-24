// WhatsApp по QR-коду — как WhatsApp Web. Бот становится «связанным устройством» вашего WhatsApp Business:
// телефон работает как раньше, ответы бота видны в нём, а вы можете вмешаться в любой момент.
// Это неофициальный способ (библиотека Baileys): WhatsApp может заблокировать номер. Бот только отвечает
// на входящие и ничего не рассылает — это снижает риск, но не убирает его.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion,
  normalizeMessageContent, getContentType, isJidGroup, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast, isPnUser, isLidUser,
} from 'baileys';
import { paths, config, log } from '../config.mjs';
import * as hub from './hub.mjs';
import { importChats, scheduleAutoStudy } from '../study.mjs';

const logger = pino({ level: 'silent' });
let sock = null;
let state = 'off';         // off | connecting | qr | connected | logged_out | error
let qrImage = null;
let me = null;
let stopped = true;
let retry = 0;
let lastError = '';
let starting = false;

const SKIP_TYPES = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage', 'messageContextInfo', 'keepInChatMessage', 'pinInChatMessage']);
const KIND = { imageMessage: 'image', audioMessage: 'audio', videoMessage: 'video', documentMessage: 'document', documentWithCaptionMessage: 'document', stickerMessage: 'sticker' };
const EXT = { image: '.jpg', audio: '.ogg', video: '.mp4', document: '.bin', sticker: '.webp' };

const num = (jid) => String(jid || '').split('@')[0].split(':')[0];

// Как бот представляется WhatsApp. Историю чатов телефон отдаёт только «WhatsApp для компьютера» (Desktop).
// WhatsApp время от времени перестаёт принимать какой-то из вариантов: в ноябре 2026 «Mac + Desktop» и «Windows + Desktop»
// стали обрываться ещё до QR-кода (код 428), а «Ubuntu + Desktop» работает. Поэтому при таком обрыве пробуем следующий
// вариант по списку. Вариант, с которым телефон привязан, запоминается рядом со входом и дальше не меняется.
const BROWSERS_HISTORY = [Browsers.ubuntu('Desktop'), Browsers.windows('Desktop'), Browsers.macOS('Chrome')];
const BROWSERS_PLAIN = [Browsers.macOS('Chrome'), Browsers.windows('Chrome')];
let browserIdx = 0;
const browserFile = () => path.join(paths.waAuth, 'browser.json');
function pickBrowser(wantHistory) {
  try { const b = JSON.parse(fs.readFileSync(browserFile(), 'utf8')); if (Array.isArray(b) && b.length === 3) return b; } catch {}
  const list = wantHistory ? BROWSERS_HISTORY : BROWSERS_PLAIN;
  return list[Math.min(browserIdx, list.length - 1)];
}

export async function start() {
  stopped = false;
  if (sock || starting) return;
  starting = true;
  state = 'connecting';
  let auth, saveCreds, version;
  try {
    fs.mkdirSync(paths.waAuth, { recursive: true });
    ({ state: auth, saveCreds } = await useMultiFileAuthState(paths.waAuth));
    try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  } finally { starting = false; }
  if (stopped || sock) return;
  // История чатов: при первом подключении WhatsApp присылает прошлую переписку — бот изучит по ней, как вы отвечаете.
  // Для этого бот представляется «WhatsApp для компьютера» (Desktop): только такому устройству телефон отдаёт историю.
  const wantHistory = config().study?.importHistory !== false;
  const browser = pickBrowser(wantHistory);
  let sawQr = false;
  const s = makeWASocket({
    auth, logger, ...(version ? { version } : {}),
    browser,
    markOnlineOnConnect: false,           // не показывать клиентам «в сети», когда бот подключён
    syncFullHistory: wantHistory,
    shouldSyncHistoryMessage: () => wantHistory,
    generateHighQualityLinkPreview: false,
  });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async (u) => {
    if (u.qr) { sawQr = true; state = 'qr'; lastError = ''; try { qrImage = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }); } catch {} }
    if (u.connection === 'open') {
      state = 'connected'; qrImage = null; retry = 0; lastError = '';
      me = { id: num(s.user?.id), name: s.user?.name || '' };
      try { if (!fs.existsSync(browserFile())) fs.writeFileSync(browserFile(), JSON.stringify(browser)); } catch {}
      log('WhatsApp (QR) подключён:', me.id);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const msg = u.lastDisconnect?.error?.message || '';
      // QR-код никто не отсканировал и он сменился (408) — это обычное ожидание, не ошибка
      const qrExpired = sawQr && code === DisconnectReason.timedOut;
      if (msg && msg !== lastError && !qrExpired) log(`WhatsApp (QR): соединение закрыто — ${msg}${code ? ` (код ${code})` : ''}`);
      lastError = msg;
      if (sock === s) sock = null;
      // WhatsApp не принял такой вариант «устройства» ещё до QR-кода — пробуем следующий
      const list = wantHistory ? BROWSERS_HISTORY : BROWSERS_PLAIN;
      if (code === DisconnectReason.connectionClosed && !sawQr && !auth.creds?.me && !fs.existsSync(browserFile()) && browserIdx < list.length - 1) {
        browserIdx++; retry = 0;
        log(`WhatsApp (QR): пробую представиться как ${list[browserIdx].slice(0, 2).join(' / ')}`);
      }
      if (code === DisconnectReason.loggedOut) {
        log('WhatsApp (QR): вышли из аккаунта — нужен новый QR-код');
        state = 'logged_out'; me = null;
        fs.rmSync(paths.waAuth, { recursive: true, force: true });
        if (!stopped) setTimeout(() => { if (!stopped) start().catch((e) => log('WhatsApp (QR):', e)); }, 3000);
        return;
      }
      if (stopped) { state = 'off'; return; }
      state = 'connecting';
      const wait = Math.min(60000, 2000 * 2 ** Math.min(retry++, 5));
      setTimeout(() => { if (!stopped) start().catch((e) => { state = 'error'; lastError = e.message; log('WhatsApp (QR):', e); }); }, wait);
    }
  });
  s.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) onMessage(s, m, type).catch((e) => log('WhatsApp (QR) входящее:', e));
  });
  s.ev.on('messaging-history.set', (h) => onHistory(s, h).catch((e) => log('WhatsApp (QR) история:', e)));
  s.ev.on('messaging-history.status', (st) => { if (st.status === 'complete') scheduleAutoStudy(20000); });
}

// ---------- прошлая переписка (приходит частями при первом подключении) ----------
const lidToPn = new Map();
const toUserJid = (j) => { const v = String(j || ''); if (!v) return ''; const [u, d] = v.split('@'); return `${u.split(':')[0]}@${d || 's.whatsapp.net'}`; };
let historyStats = { chats: 0, messages: 0 };

export async function onHistory(s, { chats = [], contacts = [], messages = [], lidPnMappings = [] }) {
  for (const m of lidPnMappings || []) if (m?.lid && m?.pn) lidToPn.set(toUserJid(m.lid), toUserJid(m.pn));
  for (const c of contacts || []) { if (c?.lid && c?.phoneNumber) lidToPn.set(toUserJid(c.lid), toUserJid(c.phoneNumber)); }
  const names = new Map();
  for (const c of contacts || []) if (c?.id) names.set(toUserJid(c.id), c.name || c.notify || c.verifiedName || '');
  for (const c of chats || []) if (c?.id && c.name) names.set(toUserJid(c.id), c.name);
  const byChat = new Map();
  for (const m of messages || []) {
    const key = m.key || {};
    let jid = key.remoteJid;
    if (!jid || !m.message || !(isPnUser(jid) || isLidUser(jid))) continue; // только личные чаты, без групп и рассылок
    const ex = extract(m.message);
    if (!ex || !ex.text) continue;
    jid = toUserJid(jid);
    let pn = isPnUser(jid) ? jid : lidToPn.get(jid) || (isPnUser(key.remoteJidAlt || '') ? toUserJid(key.remoteJidAlt) : null);
    if (!pn && isLidUser(jid)) { try { const r = await s.signalRepository?.lidMapping?.getPNForLID(jid); if (r) pn = toUserJid(r); } catch {} }
    const chatId = pn || jid;
    const entry = byChat.get(chatId) || { channel: 'waqr', chatId, phone: pn ? num(pn) : '', name: names.get(chatId) || names.get(jid) || '', messages: [] };
    if (!entry.name && !key.fromMe && m.pushName) entry.name = m.pushName;
    entry.messages.push({ fromOwner: !!key.fromMe, text: ex.text, at: Number(m.messageTimestamp?.toString?.() ?? m.messageTimestamp ?? 0) * 1000, extId: key.id });
    byChat.set(chatId, entry);
  }
  if (!byChat.size) return;
  const r = importChats([...byChat.values()], { source: 'whatsapp' });
  historyStats = { chats: historyStats.chats + r.chats, messages: historyStats.messages + r.messages };
  if (r.messages) log(`WhatsApp (QR): загружена прошлая переписка — чатов ${r.chats}, сообщений ${r.messages}`);
}

/** Текст сообщения и вид вложения — общее для новых сообщений и истории. */
function extract(message) {
  const content = normalizeMessageContent(message);
  const ctype = getContentType(content);
  if (!ctype || SKIP_TYPES.has(ctype)) return null;
  const c = content[ctype] || {};
  let text = content.conversation || content.extendedTextMessage?.text || c.caption || c.text
    || content.buttonsResponseMessage?.selectedDisplayText || content.listResponseMessage?.title || content.templateButtonReplyMessage?.selectedDisplayText || '';
  if (ctype === 'locationMessage' || ctype === 'liveLocationMessage') text = `[место на карте: ${c.degreesLatitude}, ${c.degreesLongitude}${c.name ? ', ' + c.name : ''}]`;
  if (ctype === 'contactMessage') text = `[контакт: ${c.displayName || ''}]`;
  const kind = KIND[ctype] || '';
  if (!text && kind) text = `[${({ image: 'фото', audio: 'голосовое', video: 'видео', document: 'файл', sticker: 'стикер' })[kind]}]`;
  return { text, kind, ctype, c };
}

async function onMessage(s, m, type) {
  const key = m.key || {};
  const jid = key.remoteJid;
  if (!jid || !m.message) return;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)) return;
  const at = Number(m.messageTimestamp?.toString?.() ?? m.messageTimestamp ?? 0) * 1000 || Date.now();
  // «append» — это досинхронизация; берём из неё только свежее (что пришло, пока компьютер спал)
  if (type !== 'notify' && Date.now() - at > (config().behavior.answerOldHours || 12) * 3600000) return;
  const ex = extract(m.message);
  if (!ex) return;
  const { ctype, c, kind } = ex;
  let text = ex.kind && /^\[(фото|голосовое|видео|файл|стикер)\]$/.test(ex.text) ? '' : ex.text;
  let media = null;
  if (kind) {
    media = { kind, mime: c.mimetype || '' };
    // фото (чеки, паспорта) и голосовые сохраняем, остальное — только отметка
    if ((kind === 'image' || kind === 'audio') && Number(c.fileLength || 0) < 15 * 1024 * 1024) {
      try {
        const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: s.updateMediaMessage });
        fs.mkdirSync(paths.media, { recursive: true });
        const file = path.join(paths.media, `wa-${String(key.id).replace(/[^\w-]/g, '')}${EXT[kind]}`);
        fs.writeFileSync(file, buf);
        media.path = file;
      } catch (e) { log('WhatsApp (QR): не скачалось вложение', e.message); }
    }
  }
  if (!text && !media) return;
  // номер телефона: в новых версиях WhatsApp вместо номера бывает скрытый id (@lid) — тогда номер во втором поле
  const pnJid = isPnUser(jid) ? jid : isPnUser(key.remoteJidAlt || '') ? key.remoteJidAlt : null;
  hub.inbound({
    channel: 'waqr',
    chatId: pnJid || jid,
    phone: pnJid ? num(pnJid) : '',
    name: key.fromMe ? undefined : m.pushName || '',
    text, media, extId: key.id, at, fromMe: !!key.fromMe,
  });
}

export async function stop() {
  stopped = true;
  const s = sock; sock = null;
  try { s?.end(undefined); } catch {}
  state = 'off'; qrImage = null;
}

export async function logout() {
  stopped = true;
  const s = sock; sock = null;
  try { await s?.logout(); } catch {}
  fs.rmSync(paths.waAuth, { recursive: true, force: true });
  state = 'off'; qrImage = null; me = null;
}

export const adapter = {
  async send(chatId, text) {
    if (!sock || state !== 'connected') return { ok: false, error: 'WhatsApp не подключён' };
    const r = await sock.sendMessage(chatId, { text });
    return { ok: true, extId: r?.key?.id };
  },
  async typing(chatId) {
    if (sock && state === 'connected') await sock.sendPresenceUpdate('composing', chatId);
  },
  async sendToPhone(phone, text) { return adapter.send(`${phone}@s.whatsapp.net`, text); },
  status() { return { state, qr: state === 'qr' ? qrImage : null, me, error: lastError, hasSession: fs.existsSync(path.join(paths.waAuth, 'creds.json')), history: historyStats }; },
};
