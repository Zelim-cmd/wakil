// Telegram-помощник владельца: личный бот, который
//  • присылает важное (клиент готов бронировать, сообщил об оплате, бот не знает ответа, отчёты) — с кнопками;
//  • даёт ответить клиенту прямо отсюда: ответьте (reply) на уведомление — текст уйдёт клиенту в WhatsApp/Instagram;
//  • учится и настраивается разговором: текстом, голосом, фото прайса, файлами экспорта чатов.
// Работает через «длинный опрос» (getUpdates): не нужен адрес в интернете, всё идёт с этого компьютера.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, patchConfig, paths, log } from './config.mjs';
import { get, all, run, update, kvGet, kvSet, addEvent } from './db.mjs';
import { getContact, recentMessages, openRequest, setStage, contactLabel, STAGE_LABEL, CHANNEL_LABEL } from './store.mjs';

// поздние импорты (чтобы не было круговых зависимостей при запуске)
const lazy = { documents: () => import('./documents.mjs'), agent: () => import('./agent.mjs'), learning: () => import('./learning.mjs'), analytics: () => import('./analytics.mjs'), study: () => import('./study.mjs'), voice: () => import('./voice.mjs'), hub: () => import('./channels/hub.mjs') };

let api = null;                 // для проверок можно подменить
let running = false, stopFlag = false, abort = null, offset = 0;
let me = null;
let status = { state: 'off', error: '' };
const pending = new Map();      // голосовой ответ клиенту ждёт подтверждения: key → { contactId, text }

const cfgT = () => config().telegram || {};
export function setTelegramApi(fn) { api = fn; }

async function call(method, params = {}, { form = null, timeoutMs = 30000, signal } = {}) {
  if (api) return api(method, params);
  const token = cfgT().token;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, form
    ? { method: 'POST', body: form, signal: signal || AbortSignal.timeout(timeoutMs) }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: signal || AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) { const e = new Error(j.description || 'Telegram error'); e.code = j.error_code; throw e; }
  return j.result;
}

const owner = () => String(cfgT().ownerChatId || '');
export function telegramReady() { return !!(cfgT().token && owner() && status.state === 'connected'); }
export function telegramStatus() {
  const c = cfgT();
  return { ...status, bot: me?.username || c.botUsername || '', bound: !!c.ownerChatId, ownerName: c.ownerName || '', link: me?.username ? `https://t.me/${me.username}?start=${c.bindCode}` : '' };
}

// ---------- связь «сообщение в Telegram → клиент / вопрос» ----------
function link(msgId, value) {
  const m = kvGet('tg_links', {});
  m[msgId] = value;
  const keys = Object.keys(m);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete m[k];
  kvSet('tg_links', m);
}
const linked = (msgId) => kvGet('tg_links', {})[msgId] || null;

// ---------- отправка ----------
function chunks(text, max = 3900) {
  const out = []; let s = String(text || '').trim() || '—';
  while (s.length > max) { let cut = s.lastIndexOf('\n', max); if (cut < max / 2) cut = max; out.push(s.slice(0, cut)); s = s.slice(cut).trim(); }
  out.push(s); return out;
}
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r.length) });

export async function send(text, { buttons = null, contactId = null, questionId = null, replyTo = null } = {}) {
  if (!owner() || !cfgT().token) return null;
  let last = null;
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) {
    last = await call('sendMessage', { chat_id: owner(), text: parts[i], disable_web_page_preview: true, ...(replyTo && i === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}), ...(buttons && i === parts.length - 1 ? { reply_markup: kb(buttons) } : {}) });
    if (contactId) link(last.message_id, { c: contactId });
    if (questionId) link(last.message_id, { q: questionId });
  }
  return last;
}
async function sendPhoto(file, caption, { buttons = null, contactId = null } = {}) {
  if (api) return api('sendPhoto', { file, caption, buttons });
  const fd = new FormData();
  fd.append('chat_id', owner());
  fd.append('caption', String(caption).slice(0, 1000));
  if (buttons) fd.append('reply_markup', JSON.stringify(kb(buttons)));
  fd.append('photo', new Blob([fs.readFileSync(file)]), path.basename(file));
  const m = await call('sendPhoto', {}, { form: fd, timeoutMs: 60000 });
  if (contactId) link(m.message_id, { c: contactId });
  return m;
}

const contactButtons = (id, extra = []) => [[{ text: '📖 Переписка', callback_data: `c:${id}:open` }, { text: '✋ Отвечу сам', callback_data: `c:${id}:mine` }], [...extra, { text: '✅ Решено', callback_data: `c:${id}:done` }]];
const REPLY_HINT = '\n\n↩️ Ответьте на это сообщение — текст уйдёт клиенту.';

/** Уведомление владельцу (зовёт notify.mjs). */
export async function notify(type, text, contactId = null, extra = {}) {
  if (!telegramReady()) return false;
  try {
    if (type === 'payment' && extra.paymentId) {
      const buttons = [[{ text: '✅ Деньги пришли', callback_data: `p:${extra.paymentId}:ok` }, { text: '❌ Не пришли', callback_data: `p:${extra.paymentId}:no` }], [{ text: '📖 Переписка', callback_data: `c:${contactId}:open` }]];
      if (extra.photo && fs.existsSync(extra.photo)) await sendPhoto(extra.photo, text, { buttons, contactId });
      else await send(text + REPLY_HINT, { buttons, contactId });
    } else if (contactId && (type === 'handoff' || type === 'ai_error')) {
      await send(text + REPLY_HINT, { buttons: contactButtons(contactId), contactId });
    } else if (type === 'review' || type === 'study') {
      const n = get("SELECT COUNT(*) n FROM lessons WHERE status = 'proposed'").n;
      await send(text, { buttons: n ? [[{ text: `💡 Посмотреть уроки (${n})`, callback_data: 'l:list' }]] : null });
    } else {
      await send(text, contactId ? { contactId } : {});
    }
    return true;
  } catch (e) { log('Telegram: не отправилось уведомление —', e.message); return false; }
}

// ---------- переписка клиента в Telegram ----------
async function showChat(id) {
  const c = getContact(id);
  if (!c) return send('Такого клиента уже нет.');
  const msgs = recentMessages(id, 14);
  const r = openRequest(id, false) || {};
  const who = { client: '👤', bot: '🤖', owner: '🧑‍💼', system: '⚙️' };
  const facts = [r.city && `город: ${{ makkah: 'Мекка', madinah: 'Медина', both: 'Мекка и Медина' }[r.city] || r.city}`, r.check_in && `даты: ${r.check_in} — ${r.check_out || '?'}`, r.guests && `гостей: ${r.guests}`, r.budget && `бюджет: ${r.budget} ${r.currency || ''}`].filter(Boolean).join(', ');
  const paused = c.mode === 'owner' || c.paused_until > Date.now();
  const text = `${contactLabel(c)} · ${CHANNEL_LABEL[c.channel] || c.channel}${c.phone ? ` · +${c.phone}` : ''}\nСтадия: ${STAGE_LABEL[c.stage] || c.stage}${facts ? `\n${facts}` : ''}${c.summary ? `\n${c.summary}` : ''}${c.attention ? `\n🔔 ${c.attention_reason}` : ''}\n${paused ? '✋ Бот в этом чате молчит\n' : ''}\n` +
    msgs.map((m) => `${who[m.author] || ''} ${m.media_kind === 'audio' ? '🎤 ' : m.media_kind === 'image' ? '🖼 ' : ''}${m.text || (m.media_kind ? '[вложение]' : '')}`).join('\n') + REPLY_HINT;
  const extra = paused ? [{ text: '🤖 Вернуть бота', callback_data: `c:${id}:bot` }] : [{ text: '🤖 Пусть бот ответит', callback_data: `c:${id}:think` }];
  return send(text, { buttons: [[{ text: '✋ Отвечу сам', callback_data: `c:${id}:mine` }, ...extra], [{ text: '✅ Решено', callback_data: `c:${id}:done` }]], contactId: id });
}

async function sendToClient(contactId, text, replyTo) {
  const { sendAsOwner } = await lazy.agent();
  const r = await sendAsOwner(contactId, text);
  const c = getContact(contactId);
  return send(r.ok ? `✅ Отправлено ${c ? contactLabel(c) : 'клиенту'}. Бот в этом чате молчит ${config().behavior.ownerPauseHours} ч.` : `❌ Не отправилось: ${r.error}`, { replyTo });
}

// ---------- команды ----------
const HELP = `Я ваш помощник Вакиль. Что я умею:
• присылаю важное: клиент готов бронировать, сообщил об оплате, я не знаю ответа, отчёты;
• ответьте (reply) на моё сообщение о клиенте — текст уйдёт клиенту;
• пишите или говорите голосом: «запомни: в Рамадан минимум 5 ночей», «сколько броней за неделю?», «выключи бота»;
• пришлите фото или текст прайса — разнесу по отелям;
• пришлите документ (PDF, Word, Excel, текст) — прайс, условия, описание отелей, инструкцию: цены разнесу по отелям, остальное запомню. Подпись к файлу тоже прочитаю: «цены до 31 марта»;
• пришлите файлы «Экспорт чата» из WhatsApp — изучу, как вы отвечаете клиентам.

Команды:
/status — как дела у бота
/chats — кто ждёт вашего ответа
/learn — уроки и вопросы без ответа
/report — сводка за 7 дней
/pause — выключить бота · /resume — включить
/study — изучить вашу переписку заново`;

const COMMANDS = [
  ['status', 'Как дела у бота'], ['chats', 'Кто ждёт вашего ответа'], ['learn', 'Уроки и вопросы без ответа'],
  ['report', 'Сводка за 7 дней'], ['pause', 'Выключить бота'], ['resume', 'Включить бота'], ['study', 'Изучить мою переписку'], ['help', 'Что я умею'],
];

async function cmdStatus() {
  const hub = await lazy.hub();
  const { voiceStatus } = await lazy.voice();
  const { studyStatus } = await lazy.study();
  const cfg = config();
  const st = hub.statuses();
  const ch = (s) => (s?.state === 'connected' ? '✅' : s?.state === 'qr' ? '⏳ ждёт QR-код' : s?.state === 'connecting' ? '⏳ подключается' : '—');
  const wa = st.waqr?.state === 'connected' ? st.waqr : st.wacloud;
  const v = voiceStatus();
  const s = studyStatus();
  const att = get("SELECT COUNT(*) n FROM contacts WHERE attention = 1 AND channel != 'test' AND imported = 0").n;
  const claimed = get("SELECT COUNT(*) n FROM payments WHERE status = 'claimed'").n;
  return send(`${cfg.behavior.botEnabled ? '🟢 Бот отвечает клиентам' : '⏸ Бот выключен'}
WhatsApp: ${ch(wa)} · Instagram: ${ch(st.instagram)}
ИИ: ${cfg.ai.provider}${cfg.ai.model ? ' / ' + cfg.ai.model : ''}
Голосовые: ${v.engine === 'off' ? 'выключены' : v.ready ? 'понимаю ✅' : v.loading ? 'загружаю модель…' : v.error ? '⚠️ ' + v.error : '—'}
Стиль: ${s.running ? `изучаю переписку… ${s.done}/${s.total}` : s.last && !s.last.empty ? `изучено ${new Date(s.last.at).toLocaleDateString('ru-RU')}` : 'ещё не изучал вашу переписку'}
Ждут вас: ${att} · оплат на проверку: ${claimed}`, { buttons: [[cfg.behavior.botEnabled ? { text: '⏸ Выключить бота', callback_data: 'b:off' } : { text: '▶️ Включить бота', callback_data: 'b:on' }], att ? [{ text: `🔔 Ждут вас (${att})`, callback_data: 'chats' }] : []] });
}

async function cmdChats() {
  const rows = all("SELECT * FROM contacts WHERE attention = 1 AND channel != 'test' AND imported = 0 ORDER BY last_at DESC LIMIT 15");
  if (!rows.length) return send('Никто не ждёт — бот справляется 🤍');
  return send(`🔔 Ждут вашего ответа: ${rows.length}\n\n` + rows.map((c, i) => `${i + 1}. ${contactLabel(c)} — ${c.attention_reason}`).join('\n'),
    { buttons: rows.map((c, i) => [{ text: `📖 ${i + 1}. ${contactLabel(c)}`.slice(0, 60), callback_data: `c:${c.id}:open` }]) });
}

async function cmdLearn() {
  const props = all("SELECT * FROM lessons WHERE status = 'proposed' ORDER BY id LIMIT 20");
  const qs = all("SELECT * FROM questions WHERE status = 'open' ORDER BY id DESC LIMIT 10");
  if (!props.length && !qs.length) return send('Новых уроков и вопросов нет 👍');
  if (props.length) {
    await send(`💡 Предлагаю запомнить (${props.length}). Проверьте цены и сроки — могли устареть.`, { buttons: props.length > 1 ? [[{ text: '✅ Одобрить все', callback_data: 'l:all' }]] : null });
    for (const l of props) await send(`• ${l.text}${l.why ? `\n(${l.why})` : ''}`, { buttons: [[{ text: '✅ Да', callback_data: `l:${l.id}:ok` }, { text: '❌ Нет', callback_data: `l:${l.id}:no` }]] });
  }
  for (const q of qs) await send(`❓ Клиент спросил, а я не знал ответа:\n«${q.text}»\n\n↩️ Ответьте на это сообщение — запомню ответ.`, { questionId: q.id, buttons: [[{ text: 'Не важно', callback_data: `q:${q.id}:skip` }]] });
}

async function cmdReport() {
  const { summaryText } = await lazy.analytics();
  return send(`📊 Последние 7 дней\n${summaryText(7)}`);
}

// ---------- входящие от владельца ----------
async function download(fileId, ext) {
  const f = await call('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${cfgT().token}/${f.file_path}`, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('не скачалось');
  fs.mkdirSync(paths.media, { recursive: true });
  const file = path.join(paths.media, `tg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext || path.extname(f.file_path) || ''}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

async function ownerText(text, { images = [], replyTo } = {}) {
  const { ownerChat } = await lazy.learning();
  await call('sendChatAction', { chat_id: owner(), action: 'typing' }).catch(() => {});
  const r = await ownerChat(text, { via: 'telegram', images });
  return send(r.reply || 'Готово.', { replyTo });
}

export async function handleUpdate(u) {
  if (u.callback_query) return onCallback(u.callback_query);
  const m = u.message;
  if (!m || !m.chat) return;
  const chatId = String(m.chat.id);
  const c = cfgT();
  // привязка владельца: /start <код из панели>
  if (!owner()) {
    const code = /^\/start\s+(\S+)/.exec(m.text || '')?.[1];
    if (code && code === c.bindCode && m.chat.type === 'private') {
      patchConfig({ telegram: { ownerChatId: chatId, ownerName: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') } });
      addEvent('telegram_bound', null, { name: m.from?.first_name || '' });
      await send(`Ассаламу алейкум${m.from?.first_name ? ', ' + m.from.first_name : ''}! Готово — теперь я пишу вам сюда.\n\n${HELP}`);
      return;
    }
    if (/^\/start/.test(m.text || '')) await call('sendMessage', { chat_id: chatId, text: 'Чтобы подключиться, откройте ссылку из панели Вакиля (Подключения → Telegram).' }).catch(() => {});
    return;
  }
  if (chatId !== owner()) {
    if (/^\/start/.test(m.text || '')) await call('sendMessage', { chat_id: chatId, text: 'Это личный помощник компании. Доступ есть только у владельца.' }).catch(() => {});
    return;
  }
  const replyLink = m.reply_to_message ? linked(m.reply_to_message.message_id) : null;
  try {
    // голосовое → текст
    let text = m.text || m.caption || '';
    if (m.voice || m.audio || m.video_note) {
      const { transcribeAny } = await lazy.voice();
      await call('sendChatAction', { chat_id: owner(), action: 'typing' }).catch(() => {});
      const fileId = (m.voice || m.audio || m.video_note).file_id;
      const file = await download(fileId, m.voice ? '.ogg' : '');
      const t = await transcribeAny(file, (m.voice || m.audio)?.mime_type || '');
      if (!t.ok || !t.text) return send(`🎤 Не смог разобрать голосовое${t.error ? ` (${t.error})` : ''}. Напишите, пожалуйста, текстом.`, { replyTo: m.message_id });
      text = t.text;
      // голосовой ответ клиенту — сначала покажем, что поняли
      if (replyLink?.c) {
        const key = crypto.randomBytes(4).toString('hex');
        pending.set(key, { contactId: replyLink.c, text });
        return send(`🎤 Понял так:\n«${text}»\n\nОтправить клиенту?`, { replyTo: m.message_id, buttons: [[{ text: '✅ Отправить', callback_data: `s:${key}:ok` }, { text: '✖️ Отмена', callback_data: `s:${key}:no` }]] });
      }
      await send(`🎤 «${text}»`, { replyTo: m.message_id });
    }
    // ответ на уведомление о клиенте → клиенту
    if (replyLink?.c && text && !m.photo && !m.document) return sendToClient(replyLink.c, text, m.message_id);
    // ответ на вопрос без ответа → бот запоминает
    if (replyLink?.q && text) {
      const { answerQuestion } = await lazy.learning();
      answerQuestion(replyLink.q, text);
      return send('Запомнил 👍', { replyTo: m.message_id });
    }
    // команды
    const cmd = /^\/(\w+)/.exec(text || '')?.[1];
    if (cmd) {
      if (cmd === 'start' || cmd === 'help') return send(HELP);
      if (cmd === 'status') return cmdStatus();
      if (cmd === 'chats') return cmdChats();
      if (cmd === 'learn') return cmdLearn();
      if (cmd === 'report') return cmdReport();
      if (cmd === 'pause') { patchConfig({ behavior: { botEnabled: false } }); return send('⏸ Бот выключен — клиентам отвечаете вы. Включить: /resume'); }
      if (cmd === 'resume') { patchConfig({ behavior: { botEnabled: true } }); return send('▶️ Бот снова отвечает клиентам.'); }
      if (cmd === 'study') {
        const { runStudy } = await lazy.study();
        runStudy({ mode: 'full' }).catch(() => {});
        return send('📚 Начал изучать вашу переписку — пришлю итог, когда закончу.');
      }
      return send('Не знаю такой команды. /help — что я умею.');
    }
    // фото (прайс, чек) → ассистенту с картинкой
    if (m.photo || (m.document && /^image\//.test(m.document.mime_type || '') && !/heic|heif/i.test(m.document.mime_type || ''))) {
      const id = m.photo ? m.photo[m.photo.length - 1].file_id : m.document.file_id;
      const file = await download(id, '.jpg');
      return ownerText(text || 'Посмотри на фото: если это прайс — разнеси цены по отелям; если что-то другое — скажи, что видишь.', { images: [{ path: file, mime: 'image/jpeg' }], replyTo: m.message_id });
    }
    if (m.document) {
      const name = m.document.file_name || 'документ';
      if ((m.document.file_size || 0) > 20 * 1024 * 1024) return send('Файл больше 20 МБ — Telegram не даёт боту его скачать. Загрузите его в панели: «Обучение → Документы для обучения».', { replyTo: m.message_id });
      const isChat = /\.(zip|json)$/i.test(name);
      const docs = await lazy.documents();
      if (!isChat && !/\.txt$/i.test(name)) { const problem = docs.docProblem(name); if (problem) return send(problem, { replyTo: m.message_id }); }
      const file = await download(m.document.file_id, path.extname(name));
      const buf = fs.readFileSync(file);
      fs.rm(file, { force: true }, () => {});
      // экспорт чата (.txt из WhatsApp, .zip, .json из Instagram) → изучение стиля; остальное — документ
      if (isChat || docs.looksLikeChat(name, buf)) return studyExport(name, buf);
      return learnDocument(name, buf, text, m.message_id);
    }
    if (text) return ownerText(text, { replyTo: m.message_id });
  } catch (e) {
    log('Telegram: ошибка обработки —', e.message);
    await send(`⚠️ Не получилось: ${e.message}`).catch(() => {});
  }
}

async function learnDocument(name, buf, note, replyTo) {
  const docs = await lazy.documents();
  let r;
  try { r = docs.addDocument({ name, buf, via: 'telegram', note }); } catch (e) { return send(`⚠️ ${e.message}`, { replyTo }); }
  if (r.duplicate) return send(`Этот документ я уже читал:\n\n${docs.resultText(await r.done)}`, { replyTo });
  await send(`📄 Читаю «${name}»… Обычно это 1–3 минуты.`, { replyTo });
  const typing = setInterval(() => call('sendChatAction', { chat_id: owner(), action: 'typing' }).catch(() => {}), 5000);
  try { return await send(docs.resultText(await r.done), { replyTo }); } finally { clearInterval(typing); }
}

async function studyExport(name, buf) {
  const study = await lazy.study();
  const batch = 'tg' + Date.now();
  study.stageUpload(batch, name, buf);
  const r = study.finishUpload(batch);
  if (r.needOwner) return send(`В чате несколько авторов: ${r.authors.join(', ')}. Какое имя ваше? Напишите его в панели (Обучение → Загрузить экспорт) — или пришлите сразу несколько чатов, я пойму сам.`);
  if (!r.ok) return send(r.error);
  if (!r.chats) return send(r.tooOld ? `Переписка старше ${r.months} мес. — не беру (срок меняется в настройках).` : 'Этот чат уже был загружен.');
  study.runStudy({ mode: 'full' }).catch(() => {});
  return send(`📚 Принял: чатов ${r.chats}, сообщений ${r.messages}. Изучаю, как вы отвечаете, — пришлю итог.`);
}

async function onCallback(q) {
  if (String(q.message?.chat?.id || q.from?.id) !== owner()) return call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const [kind, id, action] = String(q.data || '').split(':');
  let note = '';
  try {
    if (kind === 'c') {
      const cid = Number(id);
      const c = getContact(cid);
      if (!c) note = 'Клиента уже нет';
      else if (action === 'open') await showChat(cid);
      else if (action === 'mine') { update('contacts', cid, { paused_until: Date.now() + Number(config().behavior.ownerPauseHours || 12) * 3600000, attention: 0 }); note = `Бот молчит в этом чате ${config().behavior.ownerPauseHours} ч`; }
      else if (action === 'bot') { update('contacts', cid, { paused_until: 0, mode: 'bot' }); note = 'Бот снова отвечает этому клиенту'; }
      else if (action === 'done') { update('contacts', cid, { attention: 0, attention_reason: '' }); note = 'Отмечено: решено'; }
      else if (action === 'think') { update('contacts', cid, { paused_until: 0 }); (await lazy.agent()).think(cid).catch(() => {}); note = 'Бот думает над ответом'; }
    } else if (kind === 'p') {
      const p = get('SELECT * FROM payments WHERE id = ?', Number(id));
      if (!p) note = 'Оплата не найдена';
      else if (action === 'ok') {
        const bk = p.booking_id ? null : get("SELECT id FROM bookings WHERE contact_id = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 1", p.contact_id);
        update('payments', p.id, { status: 'confirmed', ...(bk ? { booking_id: bk.id } : {}) });
        if (p.contact_id) { setStage(p.contact_id, 'paid'); update('contacts', p.contact_id, { attention: 0, attention_reason: '' }); }
        note = `Оплата подтверждена${p.amount ? `: ${p.amount} ${p.currency}` : ''}`;
      } else { update('payments', p.id, { status: 'rejected' }); note = 'Отмечено: деньги не пришли'; }
    } else if (kind === 'l') {
      if (id === 'list') await cmdLearn();
      else if (id === 'all') { const n = run("UPDATE lessons SET status = 'active' WHERE status = 'proposed'").changes; note = `Одобрено уроков: ${n}`; }
      else { run('UPDATE lessons SET status = ? WHERE id = ?', action === 'ok' ? 'active' : 'rejected', Number(id)); note = action === 'ok' ? 'Запомнил' : 'Не буду'; }
    } else if (kind === 'q') {
      run("UPDATE questions SET status = 'ignored' WHERE id = ?", Number(id)); note = 'Хорошо, пропускаю';
    } else if (kind === 's') {
      const pnd = pending.get(id);
      pending.delete(id);
      if (!pnd) note = 'Уже неактуально';
      else if (action === 'ok') await sendToClient(pnd.contactId, pnd.text, q.message?.message_id);
      else note = 'Не отправляю';
    } else if (kind === 'b') {
      patchConfig({ behavior: { botEnabled: id === 'on' } }); note = id === 'on' ? 'Бот включён' : 'Бот выключен';
    } else if (kind === 'chats') await cmdChats();
  } catch (e) { note = 'Ошибка: ' + e.message; }
  await call('answerCallbackQuery', { callback_query_id: q.id, text: note.slice(0, 190) }).catch(() => {});
  // у сообщений с решением (оплата, урок, отправка) убираем кнопки и дописываем итог; остальное — короткой подсказкой
  const final = ['p', 's', 'q'].includes(kind) || (kind === 'l' && id !== 'list');
  if (final && q.message) {
    await call('editMessageReplyMarkup', { chat_id: owner(), message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (note) await send(`✔️ ${note}`, { replyTo: q.message.message_id }).catch(() => {});
  }
}

// ---------- опрос Telegram ----------
async function loop() {
  let backoff = 2000;
  while (!stopFlag) {
    try {
      abort = new AbortController();
      const ups = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(65000)]) });
      backoff = 2000;
      status = { state: 'connected', error: '' };
      for (const u of ups) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => log('Telegram:', e.message));
      }
    } catch (e) {
      if (stopFlag) break;
      if (e.code === 401) { status = { state: 'error', error: 'Неверный токен бота' }; break; }
      if (e.code === 409) status = { state: 'error', error: 'Этот бот уже запущен в другом месте (другой компьютер или программа)' };
      else if (e.name !== 'TimeoutError') status = { state: 'connecting', error: e.message };
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(60000, backoff * 2);
    }
  }
  running = false;
}

let startedToken = '';
export async function syncTelegram() {
  const c = cfgT();
  if (!c.token) { stopTelegram(); status = { state: 'off', error: '' }; return; }
  if (running && startedToken === c.token) return;
  stopTelegram();
  startedToken = c.token;
  try {
    me = await call('getMe');
    if (me.username && me.username !== c.botUsername) patchConfig({ telegram: { botUsername: me.username } });
    await call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch(() => {});
    await call('deleteWebhook', {}).catch(() => {});
  } catch (e) {
    status = { state: 'error', error: e.code === 401 || e.code === 404 ? 'Неверный токен бота' : e.message };
    log('Telegram:', status.error);
    return;
  }
  stopFlag = false; running = true; status = { state: 'connected', error: '' };
  log('Telegram-помощник подключён: @' + me.username);
  loop();
}
export function stopTelegram() {
  stopFlag = true;
  try { abort?.abort(); } catch {}
  running = false;
}
export function unbindTelegram() {
  patchConfig({ telegram: { ownerChatId: '', ownerName: '', bindCode: crypto.randomBytes(5).toString('hex') } });
}
