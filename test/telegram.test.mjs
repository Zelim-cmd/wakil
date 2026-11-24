// Telegram-помощник и голосовые: Telegram и ИИ подменены, расшифровка подменена (кроме чтения ogg).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wakil-tg-'));
process.env.WAKIL_DATA = DIR;
const { loadConfig, patchConfig, config, paths } = await import('../src/config.mjs');
const db = await import('../src/db.mjs');
const { setMockAi } = await import('../src/ai/providers.mjs');
const hub = await import('../src/channels/hub.mjs');
const agent = await import('../src/agent.mjs');
const tg = await import('../src/telegram.mjs');
const voice = await import('../src/voice.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(20); } return fn(); }
const tgCalls = [];      // всё, что Вакиль отправил в Telegram
const toClient = [];     // всё, что ушло клиентам
let nextMsgId = 100;
let aiReply = null;
const OWNER = '555000';

const REPLY = (o = {}) => ({ reply: 'Ответ бота', language: 'ru', client_name: null, handoff: { needed: false, reason: '', urgency: 'low' },
  facts: { city: null, hotels: [], check_in: null, check_out: null, nights: null, guests: null, rooms: null, room_type: null, meals: null, budget: null, budget_note: null, currency: null, trip_type: null, notes: null },
  stage: 'consulting', lost_reason: null, payment_claim: { claimed: false, amount: null, currency: null }, unanswered: [], summary: 'Клиент хочет отель', ...o });

before(async () => {
  loadConfig();
  patchConfig({ behavior: { botEnabled: true, debounceSec: 0, humanDelay: false }, business: { ownerPhone: '' }, telegram: { token: 'TEST', bindCode: 'secret123' } });
  db.openDb(paths.db);
  hub.onInbound(agent.handleInbound);
  hub.register('waqr', { send: async (chatId, text) => { toClient.push({ chatId, text }); return { ok: true, extId: 'w' + toClient.length }; }, status: () => ({ state: 'connected' }) });
  tg.setTelegramApi(async (method, params) => {
    tgCalls.push({ method, params });
    if (method === 'getMe') return { id: 1, username: 'wakil_test_bot' };
    if (method === 'getUpdates') { await sleep(50); return []; }
    if (method === 'getFile') return { file_path: 'voice/file_1.oga' };
    if (method === 'sendMessage' || method === 'sendPhoto') return { message_id: nextMsgId++ };
    return true;
  });
  setMockAi(async (o) => {
    if (o.purpose === 'teach') return { ok: true, data: { reply: 'Запомнил: ' + o.prompt.split('Владелец: ').pop(), lessons: [{ kind: 'rule', text: o.prompt.split('Владелец: ').pop() }], hotels: [], answers: [], retire_lessons: [], bot_enabled: /выключи/i.test(o.prompt) ? false : null } };
    return { ok: true, data: typeof aiReply === 'function' ? aiReply(o) : aiReply || REPLY() };
  });
  voice.setMockVoice(async () => ({ ok: true, text: 'Нужен отель в Медине на три ночи', lang: 'ru' }));
  await tg.syncTelegram();
});
after(async () => { tg.stopTelegram(); await sleep(150); db.closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const sentTexts = () => tgCalls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
const lastSent = () => tgCalls.filter((c) => c.method === 'sendMessage').at(-1)?.params;
const msg = (o) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: nextMsgId++, chat: { id: Number(OWNER), type: 'private' }, from: { first_name: 'Хасан' }, ...o } });

test('привязка: чужой /start не проходит, /start с кодом из панели — проходит', async () => {
  await tg.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 777, type: 'private' }, text: '/start' } });
  assert.equal(config().telegram.ownerChatId, '');
  await tg.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 777, type: 'private' }, text: '/start wrongcode' } });
  assert.equal(config().telegram.ownerChatId, '');
  await tg.handleUpdate(msg({ text: '/start secret123' }));
  assert.equal(config().telegram.ownerChatId, OWNER);
  assert.match(lastSent().text, /Ассаламу алейкум, Хасан/);
  // теперь посторонний не может управлять
  const n = tgCalls.length;
  await tg.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 777, type: 'private' }, text: '/pause' } });
  assert.equal(config().behavior.botEnabled, true);
  assert.ok(tgCalls.slice(n).every((c) => String(c.params.chat_id) !== OWNER));
});

test('клиент прислал голосовое → бот понял его; клиент готов бронировать → уведомление в Telegram с кнопками', async () => {
  aiReply = (o) => REPLY({ reply: 'Ва алейкум ассалам! Есть Мовенпик', handoff: { needed: true, reason: 'Клиент готов бронировать', urgency: 'high' } });
  fs.mkdirSync(paths.media, { recursive: true });
  const ogg = path.join(paths.media, 'v.ogg'); fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'tone.ogg'), ogg);
  hub.inbound({ channel: 'waqr', chatId: '79281110000@s.whatsapp.net', phone: '79281110000', name: 'Ахмед', text: '', media: { kind: 'audio', path: ogg }, extId: 'a1', at: Date.now() });
  await until(() => toClient.length >= 1);
  const m = db.get("SELECT * FROM messages WHERE ext_id = 'a1'");
  assert.equal(m.text, 'Нужен отель в Медине на три ночи', 'голосовое расшифровано и сохранено');
  assert.equal(m.media_kind, 'audio');
  await until(() => sentTexts().some((t) => /^🔴 Клиент готов бронировать/.test(t)));
  const n = tgCalls.filter((c) => c.method === "sendMessage").find((c) => /^🔴 Клиент готов бронировать/.test(c.params.text));
  const buttons = n.params.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(buttons.includes('📖 Переписка') && buttons.includes('✋ Отвечу сам') && buttons.includes('✅ Решено'));
  assert.match(n.params.text, /Ответьте на это сообщение/);
});

test('владелец отвечает (reply) на уведомление → текст уходит клиенту, бот замолкает в этом чате', async () => {
  const note = tgCalls.filter((c) => c.method === 'sendMessage').find((c) => /^🔴 Клиент готов бронировать/.test(c.params.text));
  const noteId = 100 + tgCalls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto').indexOf(note); // message_id выдавались по порядку
  const links = db.kvGet('tg_links', {});
  const linkedId = Object.keys(links).find((k) => links[k].c);
  const n = toClient.length;
  await tg.handleUpdate(msg({ text: 'Брат, держу номер до завтра', reply_to_message: { message_id: Number(linkedId) } }));
  assert.equal(toClient.length, n + 1);
  assert.equal(toClient.at(-1).text, 'Брат, держу номер до завтра');
  const c = db.get("SELECT * FROM contacts WHERE chat_id = '79281110000@s.whatsapp.net'");
  assert.ok(c.paused_until > Date.now());
  assert.match(lastSent().text, /Отправлено/);
  assert.ok(noteId);
});

test('голосовой ответ клиенту — сначала показываем, что поняли, отправляем по кнопке', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('/file/bot') ? new Response(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'tone.ogg'))) : realFetch(url, o));
  voice.setMockVoice(async () => ({ ok: true, text: 'Ваучер пришлю вечером', lang: 'ru' }));
  const links = db.kvGet('tg_links', {});
  const linkedId = Object.keys(links).find((k) => links[k].c);
  const n = toClient.length;
  await tg.handleUpdate(msg({ voice: { file_id: 'F1', mime_type: 'audio/ogg' }, reply_to_message: { message_id: Number(linkedId) } }));
  globalThis.fetch = realFetch;
  assert.equal(toClient.length, n, 'без подтверждения не отправили');
  const p = lastSent();
  assert.match(p.text, /Ваучер пришлю вечером/);
  const ok = p.reply_markup.inline_keyboard[0][0].callback_data;
  await tg.handleUpdate({ update_id: 9, callback_query: { id: 'cb1', data: ok, from: { id: Number(OWNER) }, message: { message_id: 1, chat: { id: Number(OWNER) } } } });
  assert.equal(toClient.at(-1).text, 'Ваучер пришлю вечером');
});

test('оплата: уведомление с кнопками, «Деньги пришли» подтверждает оплату', async () => {
  aiReply = REPLY({ reply: 'Спасибо, проверим', stage: 'paid', payment_claim: { claimed: true, amount: 5000, currency: 'SAR' } });
  db.update('contacts', db.get("SELECT id FROM contacts WHERE chat_id = '79281110000@s.whatsapp.net'").id, { paused_until: 0 });
  hub.inbound({ channel: 'waqr', chatId: '79281110000@s.whatsapp.net', text: 'Перевёл 5000', extId: 'pay', at: Date.now() });
  const call = await until(() => tgCalls.find((c) => c.method === 'sendMessage' && /^💰/.test(c.params.text)));
  const cb = call.params.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(cb, /^p:\d+:ok$/);
  await tg.handleUpdate({ update_id: 10, callback_query: { id: 'cb2', data: cb, from: { id: Number(OWNER) }, message: { message_id: 5, chat: { id: Number(OWNER) } } } });
  assert.equal(db.get('SELECT status FROM payments WHERE id = ?', Number(cb.split(':')[1])).status, 'confirmed');
});

test('свободный разговор: голосом «запомни…», текстом «выключи бота», команды', async () => {
  voice.setMockVoice(async () => ({ ok: true, text: 'Запомни: в Рамадан минимум пять ночей', lang: 'ru' }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes('/file/bot') ? new Response(Buffer.from('OggS')) : realFetch(url, o));
  await tg.handleUpdate(msg({ voice: { file_id: 'F2' } }));
  globalThis.fetch = realFetch;
  assert.ok(sentTexts().some((t) => /🎤 «Запомни: в Рамадан минимум пять ночей»/.test(t)), 'показал, что расслышал');
  assert.ok(db.get("SELECT id FROM lessons WHERE text LIKE '%Рамадан минимум пять ночей%' AND status = 'active'"));
  await tg.handleUpdate(msg({ text: 'выключи бота пока' }));
  assert.equal(config().behavior.botEnabled, false);
  await tg.handleUpdate(msg({ text: '/resume' }));
  assert.equal(config().behavior.botEnabled, true);
  await tg.handleUpdate(msg({ text: '/status' }));
  assert.match(lastSent().text, /Бот отвечает клиентам/);
});

test('уведомления идут в Telegram, а в WhatsApp — только если Telegram не подключён или так выбрано', async () => {
  const { notifyOwner } = await import('../src/notify.mjs');
  const wa = [];
  hub.register('waqr', { send: async (chatId, text) => { if (chatId.startsWith('79990001122')) wa.push(text); return { ok: true, extId: 'x' }; }, sendToPhone: async (p, text) => { wa.push(text); return { ok: true }; }, status: () => ({ state: 'connected' }) });
  patchConfig({ business: { ownerPhone: '79990001122' } });
  await notifyOwner('info', 'проверка 1');
  assert.equal(wa.length, 0);
  assert.ok(sentTexts().includes('проверка 1'));
  patchConfig({ notify: { whatsappOwner: true } });
  await notifyOwner('info', 'проверка 2');
  assert.equal(wa.length, 1);
  patchConfig({ notify: { whatsappOwner: false }, telegram: { ownerChatId: '' } });
  await notifyOwner('info', 'проверка 3');
  assert.equal(wa.at(-1), 'проверка 3', 'Telegram не привязан — запасной путь WhatsApp');
  patchConfig({ telegram: { ownerChatId: OWNER } });
});

test('голосовые: чтение OGG/Opus (как в WhatsApp и Telegram)', async () => {
  const pcm = await voice.decodeAudio(path.join(import.meta.dirname, 'fixtures', 'tone.ogg'));
  assert.ok(pcm.length > 16000 * 1.3 && pcm.length < 16000 * 1.7, `длина ${pcm.length}`);
  const rms = Math.sqrt(pcm.reduce((s, x) => s + x * x, 0) / pcm.length);
  assert.ok(rms > 0.1, 'звук не пустой');
});
