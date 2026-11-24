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
  normalizeMessageContent, getContentType, isJidGroup, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast, isPnUser,
} from 'baileys';
import { paths, config, log } from '../config.mjs';
import * as hub from './hub.mjs';

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
  const s = makeWASocket({
    auth, logger, ...(version ? { version } : {}),
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,           // не показывать клиентам «в сети», когда бот подключён
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // старую переписку не тянем — только новые сообщения
    generateHighQualityLinkPreview: false,
  });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async (u) => {
    if (u.qr) { state = 'qr'; try { qrImage = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }); } catch {} }
    if (u.connection === 'open') {
      state = 'connected'; qrImage = null; retry = 0; lastError = '';
      me = { id: num(s.user?.id), name: s.user?.name || '' };
      log('WhatsApp (QR) подключён:', me.id);
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      lastError = u.lastDisconnect?.error?.message || '';
      if (sock === s) sock = null;
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
}

async function onMessage(s, m, type) {
  const key = m.key || {};
  const jid = key.remoteJid;
  if (!jid || !m.message) return;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)) return;
  const at = Number(m.messageTimestamp?.toString?.() ?? m.messageTimestamp ?? 0) * 1000 || Date.now();
  // «append» — это досинхронизация; берём из неё только свежее (что пришло, пока компьютер спал)
  if (type !== 'notify' && Date.now() - at > (config().behavior.answerOldHours || 12) * 3600000) return;
  const content = normalizeMessageContent(m.message);
  const ctype = getContentType(content);
  if (!ctype || SKIP_TYPES.has(ctype)) return;
  const c = content[ctype] || {};
  let text = content.conversation || content.extendedTextMessage?.text || c.caption || c.text
    || content.buttonsResponseMessage?.selectedDisplayText || content.listResponseMessage?.title || content.templateButtonReplyMessage?.selectedDisplayText || '';
  if (ctype === 'locationMessage' || ctype === 'liveLocationMessage') text = `[место на карте: ${c.degreesLatitude}, ${c.degreesLongitude}${c.name ? ', ' + c.name : ''}]`;
  if (ctype === 'contactMessage') text = `[контакт: ${c.displayName || ''}]`;
  let media = null;
  const kind = KIND[ctype];
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
  status() { return { state, qr: state === 'qr' ? qrImage : null, me, error: lastError, hasSession: fs.existsSync(path.join(paths.waAuth, 'creds.json')) }; },
};
