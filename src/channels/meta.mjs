// Официальные каналы Meta: WhatsApp Business Platform (Cloud API) и Instagram (Instagram API с входом через Instagram).
// Meta присылает сообщения на наш «вебхук» — адрес в интернете (его даёт ngrok или Cloudflare Tunnel),
// а мы отвечаем через их API. Настройка — в docs/whatsapp-official.md и docs/instagram.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, patchConfig, paths, log } from '../config.mjs';
import * as hub from './hub.mjs';

const lastIn = new Map(); // chatId → id последнего входящего (для «печатает…» в WhatsApp)
const states = { wacloud: { lastWebhookAt: 0, lastError: '' }, instagram: { lastWebhookAt: 0, lastError: '' } };

/** Проверка подписи Meta: без неё кто угодно мог бы прислать нам «сообщение клиента». */
export function signatureOk(raw, header, secret) {
  if (!secret) return true; // секрет не задан — принимаем, но в панели будет предупреждение
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** GET-проверка вебхука: Meta присылает hub.challenge, мы возвращаем его, если verify_token совпал. */
export function verifyChallenge(channel, query) {
  const cfg = channel === 'instagram' ? config().channels.instagram : config().channels.waCloud;
  if (query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === cfg.verifyToken) return query.get('hub.challenge') || '';
  return null;
}

async function download(url, headers, name) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`скачивание ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error('файл слишком большой');
  fs.mkdirSync(paths.media, { recursive: true });
  const file = path.join(paths.media, name.replace(/[^\w.-]/g, ''));
  fs.writeFileSync(file, buf);
  return file;
}

// ======================= WhatsApp Cloud API =======================
const graph = (cfg) => `https://graph.facebook.com/${cfg.apiVersion || 'v23.0'}`;

async function waMedia(id, kind) {
  const cfg = config().channels.waCloud;
  const meta = await (await fetch(`${graph(cfg)}/${id}`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30000) })).json();
  if (!meta.url) throw new Error('нет ссылки на файл');
  return { path: await download(meta.url, { authorization: `Bearer ${cfg.token}` }, `wac-${id}${kind === 'audio' ? '.ogg' : '.jpg'}`), mime: meta.mime_type || '' };
}

export async function onWhatsAppWebhook(body) {
  states.wacloud.lastWebhookAt = Date.now();
  if (!config().channels.waCloud.enabled) return;
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'messages') {
        for (const m of v.messages || []) {
          const who = (v.contacts || []).find((c) => c.wa_id === m.from);
          let text = '', media = null;
          switch (m.type) {
            case 'text': text = m.text?.body || ''; break;
            case 'image': case 'audio': case 'video': case 'document': case 'sticker': {
              const o = m[m.type] || {};
              text = o.caption || (m.type === 'document' && o.filename ? `[файл ${o.filename}]` : '');
              media = { kind: m.type, mime: o.mime_type || '' };
              if ((m.type === 'image' || m.type === 'audio') && o.id) {
                try { Object.assign(media, await waMedia(o.id, m.type)); } catch (e) { log('WhatsApp (офиц.): вложение', e.message); }
              }
              break;
            }
            case 'location': text = `[место на карте: ${m.location?.latitude}, ${m.location?.longitude}${m.location?.name ? ', ' + m.location.name : ''}]`; break;
            case 'button': text = m.button?.text || ''; break;
            case 'interactive': text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || ''; break;
            case 'contacts': text = `[контакт: ${m.contacts?.[0]?.name?.formatted_name || ''}]`; break;
            default: continue; // реакции, удалённые и неподдерживаемые
          }
          if (!text && !media) continue;
          lastIn.set(m.from, m.id);
          hub.inbound({ channel: 'wacloud', chatId: m.from, phone: m.from, name: who?.profile?.name || '', text, media, extId: m.id, at: Number(m.timestamp) * 1000 || Date.now() });
        }
      }
      // «совместная работа» с приложением WhatsApp Business: ответы, отправленные с телефона
      if (ch.field === 'smb_message_echoes') {
        for (const m of v.message_echoes || []) {
          hub.inbound({ channel: 'wacloud', chatId: m.to, phone: m.to, text: m.text?.body || `[${m.type}]`, extId: m.id, at: Number(m.timestamp) * 1000 || Date.now(), fromMe: true });
        }
      }
    }
  }
}

async function waPost(payload) {
  const cfg = config().channels.waCloud;
  if (!cfg.token || !cfg.phoneNumberId) return { ok: false, error: 'WhatsApp (официальный) не настроен' };
  const r = await fetch(`${graph(cfg)}/${cfg.phoneNumberId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = j.error?.code;
    const error = code === 131047 || code === 131026
      ? 'Прошло больше 24 часов с последнего сообщения клиента — WhatsApp разрешает писать первым только по шаблону. Ответьте с телефона или подождите, пока клиент напишет.'
      : `WhatsApp: ${j.error?.message || r.status}`;
    states.wacloud.lastError = error;
    return { ok: false, error };
  }
  states.wacloud.lastError = '';
  return { ok: true, extId: j.messages?.[0]?.id };
}

export const waCloudAdapter = {
  send: (to, text) => waPost({ recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }),
  async typing(to) {
    const id = lastIn.get(to);
    if (id) await waPost({ status: 'read', message_id: id, typing_indicator: { type: 'text' } });
  },
  sendToPhone: (phone, text) => waCloudAdapter.send(phone, text),
  status() {
    const cfg = config().channels.waCloud;
    const ready = cfg.enabled && cfg.token && cfg.phoneNumberId;
    return { state: ready ? 'connected' : cfg.enabled ? 'setup' : 'off', lastWebhookAt: states.wacloud.lastWebhookAt, error: states.wacloud.lastError, signed: !!cfg.appSecret };
  },
};

// ======================= Instagram =======================
const igGraph = (cfg) => `https://graph.instagram.com/${cfg.apiVersion || 'v23.0'}`;
const igNames = new Map();

async function igProfile(id) {
  if (igNames.has(id)) return igNames.get(id);
  const cfg = config().channels.instagram;
  let p = { name: '', username: '' };
  try {
    const r = await fetch(`${igGraph(cfg)}/${id}?fields=name,username`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(20000) });
    if (r.ok) { const j = await r.json(); p = { name: j.name || '', username: j.username || '' }; }
  } catch {}
  igNames.set(id, p);
  return p;
}

export async function onInstagramWebhook(body) {
  states.instagram.lastWebhookAt = Date.now();
  const cfg = config().channels.instagram;
  if (!cfg.enabled) return;
  for (const entry of body?.entry || []) {
    const business = String(entry.id || cfg.igUserId || '');
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_deleted || m.is_unsupported) continue;
      const fromMe = !!m.is_echo || String(ev.sender?.id) === business;
      const client = String(fromMe ? ev.recipient?.id : ev.sender?.id);
      if (!client) continue;
      let text = m.text || m.quick_reply?.payload || '';
      let media = null;
      const att = (m.attachments || [])[0];
      if (att) {
        const kind = { image: 'image', audio: 'audio', video: 'video', file: 'document', story_mention: 'image', ig_reel: 'video', reel: 'video', share: 'document' }[att.type] || 'document';
        media = { kind, mime: '' };
        if (att.type === 'story_mention') text = text || '[отметил вас в истории]';
        if (att.type === 'share' || att.type === 'ig_reel' || att.type === 'reel') text = text || `[поделился публикацией${att.payload?.url ? ': ' + att.payload.url : ''}]`;
        if (!fromMe && (kind === 'image' || kind === 'audio') && att.payload?.url) {
          try { media.path = await download(att.payload.url, {}, `ig-${m.mid}${kind === 'audio' ? '.mp4' : '.jpg'}`); } catch (e) { log('Instagram: вложение', e.message); }
        }
      }
      if (!text && !media) continue;
      const prof = fromMe ? {} : await igProfile(client);
      hub.inbound({ channel: 'instagram', chatId: client, name: prof.name, username: prof.username, text, media, extId: m.mid, at: Number(ev.timestamp) || Date.now(), fromMe });
    }
  }
}

async function igPost(payload) {
  const cfg = config().channels.instagram;
  if (!cfg.token) return { ok: false, error: 'Instagram не настроен' };
  const r = await fetch(`${igGraph(cfg)}/${cfg.igUserId || 'me'}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const error = /outside of allowed window|24/i.test(j.error?.message || '')
      ? 'Прошло больше 24 часов с последнего сообщения клиента — Instagram не даёт писать первым. Ответьте из приложения.'
      : `Instagram: ${j.error?.message || r.status}`;
    states.instagram.lastError = error;
    return { ok: false, error };
  }
  states.instagram.lastError = '';
  return { ok: true, extId: j.message_id };
}

export const instagramAdapter = {
  send: (id, text) => igPost({ recipient: { id }, message: { text } }),
  async typing(id) { await igPost({ recipient: { id }, sender_action: 'typing_on' }); },
  status() {
    const cfg = config().channels.instagram;
    const ready = cfg.enabled && cfg.token;
    return { state: ready ? 'connected' : cfg.enabled ? 'setup' : 'off', lastWebhookAt: states.instagram.lastWebhookAt, error: states.instagram.lastError, signed: !!cfg.appSecret };
  },
};

/** Ключ Instagram живёт 60 дней — продлеваем раз в неделю, пока бот работает. */
export async function refreshInstagramToken() {
  const cfg = config().channels.instagram;
  if (!cfg.enabled || !cfg.token || Date.now() - (cfg.tokenRefreshedAt || 0) < 7 * 86400000) return;
  try {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(cfg.token)}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (j.access_token) { patchConfig({ channels: { instagram: { token: j.access_token, tokenRefreshedAt: Date.now() } } }); log('Instagram: ключ продлён'); }
    else { patchConfig({ channels: { instagram: { tokenRefreshedAt: Date.now() - 6 * 86400000 } } }); log('Instagram: не удалось продлить ключ', JSON.stringify(j).slice(0, 200)); }
  } catch (e) { log('Instagram: продление ключа', e.message); }
}
