// Изучение переписки владельца: бот читает прошлые чаты с клиентами и учится писать так же, как владелец.
//  Откуда берутся чаты:
//   • WhatsApp по QR — при первом подключении WhatsApp сам присылает историю (см. wa-qr.mjs);
//   • экспорт чатов WhatsApp (.txt или .zip) и выгрузка Instagram (.json) — загружаются в панели;
//   • Instagram API — последние сообщения диалогов.
//  Что получается:
//   • профиль стиля — инструкция «пиши так»: приветствия, обращение, длина, эмодзи, типичные фразы…;
//   • образцы — настоящие ответы владельца в разных ситуациях (бот видит их в каждом ответе);
//   • факты — повторяющиеся условия работы; их владелец одобряет в «Обучении» (могли устареть).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config, log } from './config.mjs';
import { get, all, insert, update, kvGet, kvSet, addEvent } from './db.mjs';
import { ask } from './ai/providers.mjs';
import { addLesson } from './learning.mjs';
import { notifyOwner, digits } from './notify.mjs';

const DAY = 86400000;
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// ---------- скрываем реквизиты и телефоны: в образцы и в ИИ они не попадают ----------
export function redact(t) {
  return String(t || '')
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}\b/g, '[IBAN]')
    .replace(/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, '[номер карты]')
    .replace(/(?<!\d)\+?\d{1,3}[ (-]{0,2}\d{3}[ )-]{0,2}\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)/g, '[телефон]')
    .replace(/(?<!\d)\d{10,14}(?!\d)/g, '[номер]');
}

// ======================= разбор файлов =======================
const INVIS = /[‎‏‪-‮⁦-⁩﻿]/g;
const SYSTEM = /(сквозн\S* шифрован|end-to-end encrypted|сообщение удалено|this message was deleted|you deleted this message|вы удалили это сообщение|пропущенный (аудио|видео)?звонок|missed (voice|video) call|создал(а)? группу|created group|изменил(а)? (тему|описание)|changed the subject|исчезающие сообщения|disappearing messages|is a contact|теперь в списке контактов|security code changed|код безопасности)/i;
const MEDIA = /^(<?(без медиафайлов|media omitted|прикреплено|attached)[^>]*>?|‎?(изображение|видео|аудио|стикер|документ|gif|image|video|audio|sticker|document) (отсутствует|omitted))/i;

const HEAD = /^\[?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:[-–]\s+)?/;

/** Экспорт чата WhatsApp (.txt) → { title, messages: [{ author, text, at }] } */
export function parseWhatsAppTxt(raw, fileName = '') {
  const lines = String(raw).replace(INVIS, '').replace(/[  ]/g, ' ').split(/\r?\n/);
  const entries = [];
  let dmy = 0, mdy = 0;
  for (const line of lines) {
    const m = HEAD.exec(line);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a > 12) dmy++; if (b > 12) mdy++;
      const rest = line.slice(m[0].length);
      const am = /^([^:]{1,60}?):\s?([\s\S]*)$/.exec(rest);
      entries.push({ m, author: am ? am[1].trim() : null, text: am ? am[2] : rest });
    } else if (entries.length) {
      entries[entries.length - 1].text += '\n' + line;
    }
  }
  const monthFirst = mdy > dmy;
  const messages = [];
  for (const e of entries) {
    if (!e.author) continue; // служебная строка
    let text = e.text.trim();
    if (!text || SYSTEM.test(text)) continue;
    if (MEDIA.test(text)) text = '[вложение]';
    const [, a, b, y, hh, mm, ss, ap] = e.m;
    const day = monthFirst ? Number(b) : Number(a), month = monthFirst ? Number(a) : Number(b);
    let year = Number(y); if (year < 100) year += 2000;
    let hour = Number(hh);
    if (ap) { const pm = /p/i.test(ap); if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
    const at = Date.UTC(year, month - 1, day, hour, Number(mm), Number(ss || 0)) - 3 * 3600000; // время телефона ≈ UTC+3
    if (!Number.isFinite(at)) continue;
    messages.push({ author: e.author, text, at });
  }
  const t = /(?:WhatsApp Chat (?:with|-)|Чат WhatsApp (?:с|-)|Chat de WhatsApp con|WhatsApp-Chat mit)\s*(.+?)(?:\.(?:txt|zip))?$/i.exec(fileName.replace(/^.*[\\/]/, ''));
  return { title: t ? t[1].trim() : '', messages };
}

/** Выгрузка Instagram/Facebook (message_1.json): текст в ней «сломан» (UTF-8 прочитан как latin1) — чиним. */
function fixMojibake(s) {
  const str = String(s ?? '');
  if (!/[\u0080-ÿ]/.test(str) || /[^\u0000-ÿ]/.test(str)) return str;
  const fixed = Buffer.from(str, 'latin1').toString('utf8');
  return fixed.includes('�') ? str : fixed;
}
export function parseInstagramJson(obj) {
  if (!obj || !Array.isArray(obj.messages)) return null;
  const messages = obj.messages
    .map((m) => ({ author: fixMojibake(m.sender_name), text: fixMojibake(m.content || (m.photos ? '[фото]' : m.audio_files ? '[голосовое]' : m.share ? '[публикация]' : '')), at: Number(m.timestamp_ms) }))
    .filter((m) => m.author && m.text && !/^(liked a message|понравилось сообщение|reacted|отреагировал)/i.test(m.text))
    .sort((a, b) => a.at - b.at);
  return { title: fixMojibake(obj.title || ''), messages, instagram: true };
}

/** Простое чтение .zip (без сторонних библиотек): возвращает файлы, чьи имена подходят под want (по умолчанию .txt и .json). */
export function readZip(buf, want = /\.(txt|json)$/i) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Файл не похож на ZIP-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!want.test(name) || /__MACOSX/.test(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    try { out.push({ name, data: method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null }); } catch {}
  }
  return out.filter((f) => f.data);
}

// ---------- загрузка файлов из панели: сначала разбираем, потом определяем, кто из авторов — владелец ----------
const staged = new Map(); // batch → { chats: [], at }

export function stageUpload(batch, fileName, buf) {
  for (const [k, v] of staged) if (Date.now() - v.at > 3600000) staged.delete(k);
  const st = staged.get(batch) || { chats: [], at: Date.now() };
  staged.set(batch, st);
  const add = (chat) => { if (chat && chat.messages.length >= 2) st.chats.push(chat); };
  const parseOne = (name, data, outerName) => {
    if (/\.json$/i.test(name)) { try { add(parseInstagramJson(JSON.parse(data.toString('utf8')))); } catch {} }
    else if (/\.txt$/i.test(name)) add(parseWhatsAppTxt(data.toString('utf8'), /^_chat\.txt$/i.test(name.replace(/^.*\//, '')) ? outerName : name));
  };
  if (/\.zip$/i.test(fileName)) for (const f of readZip(buf)) parseOne(f.name, f.data, fileName);
  else parseOne(fileName, buf, fileName);
  return { chats: st.chats.length, messages: st.chats.reduce((s, c) => s + c.messages.length, 0) };
}

/** Кто владелец: автор, который есть в большинстве чатов (или тот, кто не совпадает с названием чата). */
export function detectOwner(chats, hint = '') {
  const inChats = new Map();
  for (const c of chats) for (const a of new Set(c.messages.map((m) => m.author))) inChats.set(a, (inChats.get(a) || 0) + 1);
  const authors = [...inChats.entries()].sort((a, b) => b[1] - a[1]);
  const h = String(hint || '').trim().toLowerCase();
  if (h) { const f = authors.find(([a]) => a.toLowerCase() === h) || authors.find(([a]) => a.toLowerCase().includes(h) || h.includes(a.toLowerCase())); if (f) return { owner: f[0], authors: authors.map((a) => a[0]) }; }
  if (authors.length && chats.length >= 2 && authors[0][1] >= 2 && (!authors[1] || authors[0][1] > authors[1][1])) return { owner: authors[0][0], authors: authors.map((a) => a[0]) };
  // один чат: владелец — тот, чьё имя не совпадает с названием чата
  if (chats.length === 1 && chats[0].title) {
    const others = authors.filter(([a]) => a.toLowerCase() !== chats[0].title.toLowerCase());
    if (others.length === 1 && authors.length === 2) return { owner: others[0][0], authors: authors.map((a) => a[0]) };
  }
  return { owner: null, authors: authors.map((a) => a[0]) };
}

export function finishUpload(batch, ownerName = '') {
  const st = staged.get(batch);
  if (!st || !st.chats.length) return { ok: false, error: 'В файлах не нашлось переписки. Нужен экспорт чата WhatsApp (.txt/.zip) или выгрузка Instagram (.json).' };
  const { owner, authors } = detectOwner(st.chats, ownerName || kvGet('export_owner_name', '') || config().business.ownerName);
  if (!owner) return { ok: false, needOwner: true, authors: authors.slice(0, 30) };
  kvSet('export_owner_name', owner);
  const chats = st.chats.map((c) => {
    const client = c.messages.find((m) => m.author !== owner)?.author || c.title || 'Клиент';
    return {
      channel: 'import', chatId: 'imp:' + sha(client + '|' + (c.messages[0]?.at || '')), name: c.title || client,
      phone: /^\+?[\d\s()-]{7,}$/.test(client) ? digits(client) : '',
      messages: c.messages.map((m) => ({ fromOwner: m.author === owner, text: m.text, at: m.at, extId: 'imp' + sha(m.at + m.author + m.text) })),
    };
  }).filter((c) => c.messages.some((m) => m.fromOwner) && c.messages.some((m) => !m.fromOwner));
  staged.delete(batch);
  const r = importChats(chats, { source: 'export' });
  return { ok: true, owner, ...r };
}

// ======================= запись прошлых чатов в базу =======================
/**
 * chats: [{ channel, chatId, name?, phone?, username?, messages: [{ fromOwner, text, at, extId }] }]
 * Прошлые чаты ложатся в базу как «архив»: бот на них не отвечает, в аналитику новых клиентов они не входят.
 */
export function importChats(chats, { source = 'export' } = {}) {
  const months = Number(config().study?.months || 12);
  const since = Date.now() - months * 31 * DAY;
  const ownerPhone = digits(config().business.ownerPhone);
  let nChats = 0, nMsgs = 0, tooOld = 0;
  for (const c of chats) {
    if (ownerPhone && digits(c.phone || c.chatId).endsWith(ownerPhone.slice(-10)) && ownerPhone.length >= 7) continue;
    const msgs = c.messages.filter((m) => m.text && m.at >= since && m.at <= Date.now() + DAY).sort((a, b) => a.at - b.at);
    if (!msgs.length) { if (c.messages.length) tooOld++; continue; }
    let contact = get('SELECT * FROM contacts WHERE channel = ? AND chat_id = ?', c.channel, String(c.chatId));
    if (!contact) {
      const id = insert('contacts', {
        channel: c.channel, chat_id: String(c.chatId), name: c.name || '', phone: c.phone || '', username: c.username || '',
        created_at: msgs[0].at, last_at: msgs[msgs.length - 1].at, stage: 'new', imported: 1,
      });
      contact = get('SELECT * FROM contacts WHERE id = ?', id);
    } else if (!contact.name && c.name) update('contacts', contact.id, { name: c.name });
    let added = 0;
    for (const m of msgs) {
      const extId = m.extId ? String(m.extId) : 'h' + sha(m.at + m.text);
      if (get('SELECT id FROM messages WHERE contact_id = ? AND ext_id = ?', contact.id, extId)) continue;
      insert('messages', { contact_id: contact.id, dir: m.fromOwner ? 'out' : 'in', author: m.fromOwner ? 'owner' : 'client', text: m.text, at: m.at, ext_id: extId });
      added++;
    }
    if (added) {
      nChats++; nMsgs += added;
      const last = msgs[msgs.length - 1].at;
      if (!(contact.last_at >= last)) update('contacts', contact.id, { last_at: last });
      if (contact.created_at > msgs[0].at && contact.imported) update('contacts', contact.id, { created_at: msgs[0].at });
    }
  }
  const prev = kvGet('history_import', { chats: 0, messages: 0 });
  kvSet('history_import', { at: Date.now(), source, chats: (prev.chats || 0) + nChats, messages: (prev.messages || 0) + nMsgs });
  if (nChats) addEvent('history_import', null, { source, chats: nChats, messages: nMsgs });
  if (nChats) scheduleAutoStudy();
  return { chats: nChats, messages: nMsgs, tooOld, months };
}

// после загрузки истории — сами начинаем изучать (подождав, пока догрузятся остальные части)
let autoTimer = null;
export function scheduleAutoStudy(ms = 90000) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    const last = kvGet('last_study', null);
    const hist = kvGet('history_import', null);
    if (!hist || (last && last.at > hist.at)) return;
    // после загрузки истории изучаем всё заново: в истории старые чаты, которых прошлое изучение не видело
    runStudy({ mode: 'full' }).catch((e) => log('Изучение переписки:', e));
  }, ms);
}

// ======================= Instagram: последние сообщения диалогов =======================
export async function fetchInstagramHistory() {
  const cfg = config().channels.instagram;
  if (!cfg.token) return { ok: false, error: 'Instagram не подключён' };
  const base = `https://graph.instagram.com/${cfg.apiVersion || 'v23.0'}`;
  let url = `${base}/${cfg.igUserId || 'me'}/conversations?platform=instagram&limit=50&fields=${encodeURIComponent('participants,messages.limit(25){id,created_time,from,message}')}`;
  const chats = [];
  for (let page = 0; url && page < 8; page++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `Instagram: ${j.error?.message || r.status}` };
    for (const conv of j.data || []) {
      const msgs = conv.messages?.data || [];
      const me = String(cfg.igUserId || '');
      const other = (conv.participants?.data || []).find((p) => String(p.id) !== me) || {};
      chats.push({
        channel: 'instagram', chatId: String(other.id || conv.id), name: other.username || '', username: other.username || '',
        messages: msgs.map((m) => ({ fromOwner: me ? String(m.from?.id) === me : String(m.from?.id) !== String(other.id), text: m.message || '', at: Date.parse(m.created_time), extId: m.id })),
      });
    }
    url = j.paging?.next || null;
  }
  return { ok: true, ...importChats(chats, { source: 'instagram' }) };
}

// ======================= изучение =======================
let status = { running: false };
export function isStudying() { return !!status.running; }
export function studyStatus() { return { ...status, last: kvGet('last_study', null), history: kvGet('history_import', null), months: Number(config().study?.months || 12) }; }

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    relevant: { type: 'array', items: { type: 'integer' }, description: 'Номера чатов, которые про работу (отели, поездки). Личные — не включать.' },
    style: { type: 'string', description: 'Подробные наблюдения о манере владельца в этих чатах, с дословными типичными фразами в кавычках' },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          situation: { type: 'string', description: 'Ситуация коротко: первое сообщение, вопрос о цене, «дорого», оплата…' },
          client: { type: 'string', description: 'Сообщение клиента' },
          owner: { type: 'string', description: 'Ответ владельца ДОСЛОВНО (несколько его сообщений подряд — через перенос строки)' },
        },
        required: ['situation', 'client', 'owner'],
      },
    },
    facts: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['rule', 'faq'] }, text: { type: 'string' } }, required: ['kind', 'text'] } },
    hotels: { type: 'array', items: { type: 'string' } },
  },
  required: ['relevant', 'style', 'examples', 'facts', 'hotels'],
};
const REDUCE_SCHEMA = {
  type: 'object',
  properties: {
    profile: { type: 'string', description: 'Профиль стиля владельца — инструкция для помощника, 15–35 строк' },
    examples: MAP_SCHEMA.properties.examples,
    facts: MAP_SCHEMA.properties.facts,
    report: { type: 'string', description: 'Отчёт владельцу по-русски: что изучено и что понято о его манере, 4–8 строк' },
  },
  required: ['profile', 'examples', 'facts', 'report'],
};

const MAP_SYSTEM = `Ты изучаешь переписку владельца небольшого агентства (бронирует отели в Мекке и Медине для паломников) с клиентами. Цель — чтобы ИИ-помощник научился писать клиентам ТОЧНО КАК ВЛАДЕЛЕЦ, и клиент не заметил разницы.
В чатах: «Клиент:» — клиент, «Владелец:» — сам владелец, «Бот:» — автоответчик (его манеру НЕ изучай). Чаты, не связанные с работой (личные, семейные), пропусти — не включай их в relevant и не бери из них примеры.
Изучи только манеру владельца:
• приветствие и прощание, как обращается (на «вы»/«ты», по имени, «брат», «сестра», «дорогой»…);
• длина сообщений, пишет одним сообщением или несколькими короткими, пунктуация, заглавные буквы;
• эмодзи (какие и как часто), исламские выражения (ин ша Аллах, баракаЛлаху фикум и т.д.), язык и смешение языков;
• как предлагает отели и называет цены, как задаёт вопросы, как отвечает на «дорого» и сомнения, как подталкивает к брони, как просит предоплату, как реагирует на оплату и благодарность;
• дословные типичные фразы.
examples — 3–8 самых показательных пар из РАЗНЫХ ситуаций; ответ владельца — точно его словами (имена клиентов замени на [имя]).
facts — повторяющиеся условия работы, как их формулирует владелец (оплата, предоплата, отмена, трансфер, визы, что входит). Без конкретных цен, дат и номеров комнат — они устаревают.
hotels — какие отели встречались.`;

const REDUCE_SYSTEM = `Ты собираешь из заметок по частям переписки единый ПРОФИЛЬ СТИЛЯ владельца агентства (отели в Мекке и Медине для паломников). Это инструкция для ИИ-помощника: как писать клиентам от имени владельца, чтобы клиент не отличил.
Пиши во втором лице («Здоровайся так: …», «Обращайся на „вы“…»), конкретно, с дословными типичными фразами в кавычках. 15–35 строк, разделы:
1) Приветствие, обращение, прощание; 2) Длина и ритм сообщений; 3) Тон, эмодзи, выражения; 4) Типичные фразы; 5) Как предлагает отели и говорит о ценах; 6) Как отвечает на «дорого» и сомнения; 7) Как ведёт к брони и оплате; 8) Чего владелец не делает.
Не придумывай того, чего нет в заметках. Правила о ценах, реквизитах и честности помощник получает отдельно — их сюда не пиши.
examples — выбери 12–20 лучших и РАЗНЫХ образцов (первое сообщение, подбор, цена, «дорого», думает, бронь, оплата, благодарность, отказ, вопрос не по теме); текст владельца — дословно.
facts — правила и ответы для помощника в повелительном наклонении («Предоплата — 30%, в Рамадан — 50%», «На вопрос о детях отвечай: …»). Объедини повторы, оставь до 12 самых полезных. Не включай списки отелей и описания манеры (манера — в профиле), не пиши о владельце в третьем лице.
report — владельцу по-русски: сколько чатов изучено и что ты понял о его манере (3–5 пунктов «вы…»), что предлагаешь запомнить.`;

function chatTranscript(c, msgs) {
  const lines = msgs.map((m) => `${m.author === 'owner' ? 'Владелец' : m.author === 'bot' ? 'Бот' : 'Клиент'}: ${redact(m.text).slice(0, 1500)}`);
  let t = lines.join('\n');
  if (t.length > 6000) t = '…\n' + t.slice(-6000);
  return t;
}

/** Изучить переписку. mode: full — заново; update — только новые ответы владельца, уточняя профиль. */
export async function runStudy({ mode = 'full' } = {}) {
  if (status.running) return { ok: false, error: 'Изучение уже идёт' };
  const last = kvGet('last_study', null);
  const since = mode === 'update' && last ? last.at : 0;
  status = { running: true, phase: 'Собираю переписку', done: 0, total: 0, startedAt: Date.now(), mode };
  try {
    const maxChars = Number(config().study?.maxChars || 300000);
    const months = Number(config().study?.months || 12);
    const from = Math.max(since, Date.now() - months * 31 * DAY);
    // чаты, где владелец сам отвечал клиенту
    const candidates = all(`SELECT c.* FROM contacts c WHERE c.channel != 'test'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.author = 'owner' AND m.at >= ?)
        AND EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = c.id AND m.author = 'client')
      ORDER BY c.last_at DESC LIMIT 400`, from);
    const blocks = [];
    let total = 0, ownerMsgs = 0;
    for (const c of candidates) {
      const msgs = all('SELECT author, text, at FROM messages WHERE contact_id = ? AND at >= ? ORDER BY at, id', c.id, mode === 'update' ? from - 2 * DAY : from).slice(-80);
      if (!msgs.some((m) => m.author === 'owner')) continue;
      const t = chatTranscript(c, msgs);
      if (total + t.length > maxChars) break;
      total += t.length;
      ownerMsgs += msgs.filter((m) => m.author === 'owner').length;
      blocks.push({ id: c.id, text: t });
    }
    if (!blocks.length) {
      const report = mode === 'update' ? 'Новых ваших ответов клиентам пока нет — профиль не менялся.' : 'Пока нечего изучать: нет переписки, где вы сами отвечали клиентам. Подключите WhatsApp по QR-коду (бот загрузит историю) или загрузите экспорт чатов.';
      if (mode !== 'update') kvSet('last_study', { at: Date.now(), report, chats: 0, messages: 0, empty: true });
      return { ok: true, empty: true, report };
    }
    // по частям — примерно по 30 тыс. знаков
    const batches = [];
    let cur = [], size = 0;
    for (const b of blocks) {
      if (size + b.text.length > 30000 && cur.length) { batches.push(cur); cur = []; size = 0; }
      cur.push(b); size += b.text.length;
    }
    if (cur.length) batches.push(cur);
    status = { ...status, phase: 'Читаю чаты', total: batches.length + 1 };
    const notes = [];
    for (const batch of batches) {
      const r = await ask({
        purpose: 'study', schema: MAP_SCHEMA, timeoutMs: 420000, system: MAP_SYSTEM,
        prompt: batch.map((b) => `### Чат №${b.id}\n${b.text}`).join('\n\n'),
      });
      status.done++;
      if (r.ok) notes.push(r.data);
      else log('Изучение: часть не прочитана —', r.code, r.message);
      if (!r.ok && r.code === 'limit') break;
    }
    if (!notes.length) throw new Error('ИИ не смог прочитать переписку (см. журнал). Попробуйте позже.');
    status.phase = 'Собираю ваш стиль';
    const relevant = new Set(notes.flatMap((n) => n.relevant || []));
    const oldProfile = mode === 'update' ? kvGet('style_profile', null)?.text || '' : '';
    const oldExamples = mode === 'update' ? kvGet('style_examples', []) : [];
    const candidatesEx = [...oldExamples, ...notes.flatMap((n) => n.examples || [])].slice(0, 80);
    const r = await ask({
      purpose: 'study', smart: true, schema: REDUCE_SCHEMA, timeoutMs: 420000, system: REDUCE_SYSTEM,
      prompt: [
        oldProfile ? `ТЕКУЩИЙ ПРОФИЛЬ (уточни и дополни по новым ответам владельца, верное не теряй):\n${oldProfile}` : '',
        `ЗАМЕТКИ О СТИЛЕ ПО ЧАСТЯМ (${notes.length}):\n${notes.map((n, i) => `--- часть ${i + 1}\n${n.style}`).join('\n')}`,
        `КАНДИДАТЫ В ОБРАЗЦЫ (JSON):\n${JSON.stringify(candidatesEx)}`,
        `ФАКТЫ (JSON):\n${JSON.stringify(notes.flatMap((n) => n.facts || []).slice(0, 80))}`,
        `ОТЕЛИ, КОТОРЫЕ ВСТРЕЧАЛИСЬ: ${[...new Set(notes.flatMap((n) => n.hotels || []))].slice(0, 40).join(', ') || '—'}`,
        `Изучено чатов о работе: ${relevant.size || blocks.length}, ответов владельца: ${ownerMsgs}.`,
      ].filter(Boolean).join('\n\n'),
    });
    if (!r.ok) throw new Error('Не удалось собрать стиль: ' + r.message);
    status.done++;
    const d = r.data;
    const examples = (d.examples || []).filter((e) => e.owner && e.client).slice(0, 20)
      .map((e) => ({ situation: String(e.situation || '').slice(0, 120), client: redact(e.client).slice(0, 600), owner: redact(e.owner).slice(0, 900) }));
    kvSet('style_profile', { text: String(d.profile || '').trim(), at: Date.now(), chats: relevant.size || blocks.length, messages: ownerMsgs, edited: false });
    kvSet('style_examples', examples);
    let facts = 0;
    for (const f of d.facts || []) if (addLesson({ kind: f.kind === 'faq' ? 'faq' : 'rule', text: redact(f.text), why: 'из вашей прошлой переписки', source: 'history', status: 'proposed' })) facts++;
    const report = String(d.report || '').trim();
    kvSet('last_study', { at: Date.now(), report, chats: relevant.size || blocks.length, messages: ownerMsgs, facts, mode });
    addEvent('study', null, { chats: relevant.size || blocks.length, messages: ownerMsgs, facts, mode });
    notifyOwner('study', `📚 ${mode === 'update' ? 'Доизучил ваши новые ответы' : 'Изучил вашу переписку'}: чатов ${relevant.size || blocks.length}, ваших ответов ${ownerMsgs}.\n${report}${facts ? `\nПредлагаю запомнить фактов: ${facts} — одобрите в «Обучении».` : ''}\nПроверьте, похоже ли я пишу: «Проверить бота» в панели.`);
    return { ok: true, report, chats: relevant.size || blocks.length, messages: ownerMsgs, facts };
  } catch (e) {
    log('Изучение переписки:', e.message);
    status.error = e.message;
    return { ok: false, error: e.message };
  } finally {
    const err = status.error;
    status = { running: false, ...(err ? { error: err } : {}) };
  }
}

/** Для инструкции бота: профиль и образцы. */
export function styleForPrompt() {
  const p = kvGet('style_profile', null);
  const ex = kvGet('style_examples', []);
  if (!p?.text && !ex.length) return '';
  const exText = ex.slice(0, 20).map((e) => `[${e.situation}]\nКлиент: ${e.client}\nВладелец: ${e.owner}`).join('\n---\n');
  return `${p?.text || ''}${exText ? `\n\nНАСТОЯЩИЕ ОТВЕТЫ ВЛАДЕЛЬЦА — бери из них манеру, слова и длину. Цены, даты, наличие мест и реквизиты в них устарели — их НЕ используй:\n${exText}` : ''}`;
}

export function saveProfile(text) {
  const p = kvGet('style_profile', {}) || {};
  kvSet('style_profile', { ...p, text: String(text || '').trim(), at: Date.now(), edited: true });
}
export function deleteExample(i) {
  const ex = kvGet('style_examples', []);
  ex.splice(Number(i), 1);
  kvSet('style_examples', ex);
}

/** Раз в неделю: доизучить новые ответы владельца (если их набралось). */
export async function weeklyRestudy() {
  if (config().study?.weekly === false || status.running) return;
  const last = kvGet('last_study', null);
  if (!last || last.empty || Date.now() - last.at < 7 * DAY) return;
  const n = get("SELECT COUNT(*) n FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE m.author = 'owner' AND m.at > ? AND c.channel != 'test'", last.at).n;
  if (n < 5) return;
  log('Доизучаю новые ответы владельца:', n);
  await runStudy({ mode: 'update' });
}
