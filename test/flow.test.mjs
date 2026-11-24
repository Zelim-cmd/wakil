// Проверки без настоящего ИИ и без WhatsApp: ИИ подменяется, каналы — заглушки.
// Запуск: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wakil-test-'));
process.env.WAKIL_DATA = DIR;

const { loadConfig, patchConfig, paths } = await import('../src/config.mjs');
const db = await import('../src/db.mjs');
const { setMockAi, parseJson, strictSchema } = await import('../src/ai/providers.mjs');
const hub = await import('../src/channels/hub.mjs');
const agent = await import('../src/agent.mjs');
const { saveHotel, hotelsText, ensureKnowledge } = await import('../src/knowledge.mjs');
const { stats, exportCsv } = await import('../src/analytics.mjs');
const { waCloudAdapter, instagramAdapter } = await import('../src/channels/meta.mjs');
const { startServers } = await import('../src/web.mjs');

const sent = [];              // что «ушло» клиентам
let aiReply = null;           // что вернёт подменённый ИИ
let aiCalls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(20); } return fn(); }

const base = (o = {}) => ({
  reply: 'Ва алейкум ассалам! Подскажите даты?', language: 'ru', client_name: null,
  handoff: { needed: false, reason: '', urgency: 'low' },
  facts: { city: null, hotels: [], check_in: null, check_out: null, nights: null, guests: null, rooms: null, room_type: null, meals: null, budget: null, budget_note: null, currency: null, trip_type: null, notes: null },
  stage: 'consulting', lost_reason: null, payment_claim: { claimed: false, amount: null, currency: null }, unanswered: [], summary: 'Клиент спрашивает про отель', ...o,
});

let servers;
before(async () => {
  loadConfig();
  patchConfig({ behavior: { debounceSec: 0, humanDelay: false }, business: { ownerPhone: '79990001122' }, panel: { port: 0, webhookPort: 0 } });
  db.openDb(paths.db);
  ensureKnowledge();
  hub.onInbound(agent.handleInbound);
  const fake = (channel) => ({ send: async (chatId, text) => { const id = channel + '-' + sent.length; sent.push({ channel, chatId, text, id }); return { ok: true, extId: id }; }, status: () => ({ state: 'connected' }), sendToPhone: async (p, text) => { sent.push({ channel, chatId: 'owner:' + p, text }); return { ok: true }; } });
  hub.register('waqr', fake('waqr'));
  setMockAi(async (o) => { aiCalls.push(o); return typeof aiReply === 'function' ? aiReply(o) : { ok: true, text: JSON.stringify(aiReply ?? base()), data: aiReply ?? base() }; });
  servers = startServers();
  await servers.ready;
});
after(async () => { await sleep(300); servers?.panel.close(); servers?.hooks.close(); db.closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

test('клиент пишет → бот отвечает, запоминает запрос и интерес к отелю', async () => {
  saveHotel({ name: 'Swissôtel Makkah', city: 'Мекка', stars: 5, prices: '900 SAR', prices_until: '2099-01-01' });
  aiReply = base({ reply: 'Предлагаю Swissôtel Makkah', stage: 'offer', facts: { ...base().facts, city: 'makkah', hotels: ['swissotel makkah', 'Swissôtel Makkah'], check_in: '2027-03-10', check_out: '2027-03-15', guests: 4, budget: 800, currency: 'SAR' } });
  hub.inbound({ channel: 'waqr', chatId: '79281112233@s.whatsapp.net', phone: '79281112233', name: 'Ахмед', text: 'Салам, отель в Мекке 10–15 марта на 4', extId: 'm1', at: Date.now() });
  await until(() => sent.length >= 1);
  assert.equal(sent[0].text, 'Предлагаю Swissôtel Makkah');
  const c = db.get("SELECT * FROM contacts WHERE chat_id = '79281112233@s.whatsapp.net'");
  assert.equal(c.stage, 'offer');
  assert.equal(c.name, 'Ахмед');
  const r = db.get('SELECT * FROM requests WHERE contact_id = ?', c.id);
  assert.equal(r.nights, 5, 'ночи считаются по датам');
  assert.equal(r.guests, 4);
  assert.deepEqual(JSON.parse(r.hotels), ['Swissôtel Makkah'], 'названия отелей сводятся к карточке');
  assert.equal(db.get('SELECT COUNT(*) n FROM interests WHERE contact_id = ?', c.id).n, 1);
  // в инструкцию ИИ попали знания и прайс
  assert.match(aiCalls.at(-1).system, /Swissôtel Makkah/);
  assert.match(aiCalls.at(-1).prompt, /Салам, отель в Мекке/);
});

test('повтор того же сообщения от WhatsApp не обрабатывается дважды', async () => {
  const before = aiCalls.length;
  hub.inbound({ channel: 'waqr', chatId: '79281112233@s.whatsapp.net', phone: '79281112233', text: 'Салам, отель в Мекке 10–15 марта на 4', extId: 'm1', at: Date.now() });
  await sleep(200);
  assert.equal(aiCalls.length, before);
});

test('несколько сообщений подряд → один ответ на все', async () => {
  patchConfig({ behavior: { debounceSec: 0.3 } });
  const n = sent.length, calls = aiCalls.length;
  aiReply = base({ reply: 'Ответ на оба' });
  for (const [i, t] of ['И ещё', 'с завтраком'].entries()) hub.inbound({ channel: 'waqr', chatId: '79281112233@s.whatsapp.net', text: t, extId: 'burst' + i, at: Date.now() });
  await until(() => sent.length > n, 3000);
  await sleep(500);
  assert.equal(sent.length, n + 1);
  assert.equal(aiCalls.length, calls + 1);
  assert.match(aiCalls.at(-1).prompt, /И ещё[\s\S]*с завтраком/);
  patchConfig({ behavior: { debounceSec: 0 } });
});

test('эхо собственного ответа бота не считается ответом владельца', async () => {
  const c = db.get("SELECT * FROM contacts WHERE chat_id = '79281112233@s.whatsapp.net'");
  hub.inbound({ channel: 'waqr', chatId: c.chat_id, text: 'Ответ на оба', extId: sent.at(-1).id, at: Date.now(), fromMe: true });
  await sleep(100);
  assert.equal(db.get('SELECT paused_until FROM contacts WHERE id = ?', c.id).paused_until, 0);
});

test('владелец ответил сам с телефона → бот молчит в этом чате', async () => {
  const c = db.get("SELECT * FROM contacts WHERE chat_id = '79281112233@s.whatsapp.net'");
  hub.inbound({ channel: 'waqr', chatId: c.chat_id, text: 'Ахмед, держу вам номер до завтра', extId: 'own1', at: Date.now(), fromMe: true });
  await sleep(100);
  const after = db.get('SELECT * FROM contacts WHERE id = ?', c.id);
  assert.ok(after.paused_until > Date.now() + 3600000, 'пауза на часы');
  assert.equal(db.get("SELECT author FROM messages WHERE ext_id = 'own1'").author, 'owner');
  const n = sent.length;
  hub.inbound({ channel: 'waqr', chatId: c.chat_id, text: 'Спасибо!', extId: 'm-after', at: Date.now() });
  await sleep(300);
  assert.equal(sent.length, n, 'бот не отвечает, пока владелец ведёт чат');
  db.update('contacts', c.id, { paused_until: 0 });
});

test('клиент готов бронировать и сообщает об оплате → владельцу уведомление и оплата на проверку', async () => {
  aiReply = base({ reply: 'Спасибо! Менеджер проверит', stage: 'paid', handoff: { needed: true, reason: 'Клиент сообщил об оплате', urgency: 'high' }, payment_claim: { claimed: true, amount: 9000, currency: 'SAR' } });
  const n = sent.length;
  hub.inbound({ channel: 'waqr', chatId: '79281112233@s.whatsapp.net', text: 'Перевёл 9000', extId: 'pay1', at: Date.now() });
  await until(() => sent.length >= n + 3);
  const owner = sent.filter((s) => s.chatId === 'owner:79990001122');
  assert.ok(owner.some((s) => /оплат/i.test(s.text)), 'владельцу пришло про оплату');
  const p = db.get("SELECT * FROM payments WHERE status = 'claimed'");
  assert.equal(p.amount, 9000);
  const c = db.get("SELECT * FROM contacts WHERE chat_id = '79281112233@s.whatsapp.net'");
  assert.equal(c.attention, 1);
  assert.equal(c.stage, 'paid');
});

test('вопрос без ответа попадает в обучение', async () => {
  aiReply = base({ reply: 'Уточню у менеджера', unanswered: ['Есть ли трансфер из Джидды?'] });
  hub.inbound({ channel: 'waqr', chatId: '79281112233@s.whatsapp.net', text: 'А трансфер есть?', extId: 'q1', at: Date.now() });
  await until(() => db.get("SELECT id FROM questions WHERE text = 'Есть ли трансфер из Джидды?'"));
  assert.ok(db.get("SELECT id FROM questions WHERE text = 'Есть ли трансфер из Джидды?'"));
});

test('ИИ недоступен → клиенту вежливый ответ один раз, владельцу предупреждение', async () => {
  aiReply = () => ({ ok: false, code: 'limit', message: 'usage limit reached' });
  const n = sent.length;
  hub.inbound({ channel: 'waqr', chatId: '79285556677@s.whatsapp.net', phone: '79285556677', text: 'Здравствуйте', extId: 'f1', at: Date.now() });
  await until(() => sent.length >= n + 2);
  const toClient = sent.slice(n).filter((s) => s.chatId === '79285556677@s.whatsapp.net');
  assert.equal(toClient.length, 1);
  assert.match(toClient[0].text, /Менеджер ответит/);
  assert.ok(sent.slice(n).some((s) => s.chatId === 'owner:79990001122' && /лимит/.test(s.text)));
  hub.inbound({ channel: 'waqr', chatId: '79285556677@s.whatsapp.net', text: 'Алло?', extId: 'f2', at: Date.now() });
  await sleep(300);
  assert.equal(sent.filter((s) => s.chatId === '79285556677@s.whatsapp.net').length, 1, 'второй раз не шлём');
});

test('владелец пишет боту со своего номера → это обучение, а не клиент', async () => {
  aiReply = (o) => (o.purpose === 'teach'
    ? { ok: true, data: { reply: 'Запомнил', lessons: [{ kind: 'rule', text: 'В Рамадан минимум 5 ночей' }], hotels: [], answers: [], retire_lessons: [] } }
    : { ok: true, data: base() });
  const n = sent.length;
  hub.inbound({ channel: 'waqr', chatId: '79990001122@s.whatsapp.net', phone: '79990001122', text: 'Запомни: в Рамадан минимум 5 ночей', extId: 'o1', at: Date.now() });
  await until(() => sent.length > n);
  assert.equal(sent.at(-1).text, 'Запомнил');
  assert.ok(db.get("SELECT id FROM lessons WHERE text = 'В Рамадан минимум 5 ночей' AND status = 'active'"));
  assert.equal(db.get("SELECT COUNT(*) n FROM contacts WHERE chat_id = '79990001122@s.whatsapp.net'").n, 0, 'владелец не стал «клиентом»');
});

test('сообщения старше заданного окна сохраняются, но бот на них не отвечает', async () => {
  const calls = aiCalls.length;
  hub.inbound({ channel: 'waqr', chatId: '79287778899@s.whatsapp.net', text: 'Старое', extId: 'old1', at: Date.now() - 48 * 3600000 });
  await sleep(200);
  assert.equal(aiCalls.length, calls);
  assert.ok(db.get("SELECT id FROM messages WHERE ext_id = 'old1'"));
});

test('прайс с прошедшей датой бот не называет', () => {
  saveHotel({ name: 'Old Price Hotel', city: 'makkah', prices: '500 SAR', prices_until: '2020-01-01' });
  const t = hotelsText();
  assert.match(t, /Old Price Hotel[\s\S]*устарели[\s\S]*НЕ называй/);
  assert.doesNotMatch(t, /Old Price Hotel[^#]*500 SAR/);
});

const post = (port, p, body, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('вебхук WhatsApp (официальный): подпись проверяется, сообщение доходит до бота', async () => {
  const port = servers.hooks.address().port;
  patchConfig({ channels: { waCloud: { enabled: true, token: 't', phoneNumberId: '123', appSecret: 'sekret', verifyToken: 'vt' } } });
  hub.register('wacloud', { ...waCloudAdapter, send: async (to, text) => { sent.push({ channel: 'wacloud', chatId: to, text }); return { ok: true, extId: 'wamid.out' + sent.length }; }, typing: async () => {} });
  const ok = await fetch(`http://127.0.0.1:${port}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777`);
  assert.equal(await ok.text(), '777');
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: '966500000001', profile: { name: 'Юсуф' } }], messages: [{ from: '966500000001', id: 'wamid.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hello, hotel in Madinah?' } }] } }] }] });
  const bad = await post(port, '/webhook/whatsapp', body, { 'x-hub-signature-256': 'sha256=00' });
  assert.equal(bad.status, 401, 'чужая подпись отклонена');
  aiReply = base({ reply: 'Yes, we have hotels in Madinah' });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'sekret').update(body).digest('hex');
  const r = await post(port, '/webhook/whatsapp', body, { 'x-hub-signature-256': sig });
  assert.equal(r.status, 200);
  await until(() => sent.some((s) => s.channel === 'wacloud'));
  const c = db.get("SELECT * FROM contacts WHERE channel = 'wacloud'");
  assert.equal(c.name, 'Юсуф');
  assert.equal(sent.find((s) => s.channel === 'wacloud').chatId, '966500000001');
});

test('вебхук Instagram: входящее и эхо ответа из приложения', async () => {
  const port = servers.hooks.address().port;
  patchConfig({ channels: { instagram: { enabled: true, token: 't', igUserId: '1784', appSecret: '' } } });
  hub.register('instagram', { ...instagramAdapter, send: async (to, text) => { sent.push({ channel: 'instagram', chatId: to, text }); return { ok: true, extId: 'mid.out' + sent.length }; }, typing: async () => {} });
  aiReply = base({ reply: 'Здравствуйте! Чем помочь?' });
  const msg = { object: 'instagram', entry: [{ id: '1784', messaging: [{ sender: { id: '555' }, recipient: { id: '1784' }, timestamp: Date.now(), message: { mid: 'mid.1', text: 'Салам, цены?' } }] }] };
  assert.equal((await post(port, '/webhook/instagram', msg)).status, 200);
  await until(() => sent.some((s) => s.channel === 'instagram'));
  const echo = { object: 'instagram', entry: [{ id: '1784', messaging: [{ sender: { id: '1784' }, recipient: { id: '555' }, timestamp: Date.now(), message: { mid: 'mid.owner', text: 'Отвечу лично', is_echo: true } }] }] };
  await post(port, '/webhook/instagram', echo);
  await sleep(150);
  const c = db.get("SELECT * FROM contacts WHERE channel = 'instagram'");
  assert.ok(c.paused_until > Date.now(), 'ответ из приложения Instagram ставит бота на паузу');
});

test('панель: запросы без особого заголовка и с чужого адреса отклоняются', async () => {
  const port = servers.panel.address().port;
  assert.equal((await post(port, '/api/test/reset', {})).status, 403);
  const http = await import('node:http');
  const foreign = await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/api/overview', headers: { host: 'evil.example' } }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(foreign, 403, 'чужой адрес (защита от подмены DNS)');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`)).status, 200);
  const s = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  assert.equal(s.config.channels.waCloud.token, '••••t', 'секреты в панель не отдаются');
});

test('аналитика и выгрузка', async () => {
  const c = db.get("SELECT * FROM contacts WHERE chat_id = '79281112233@s.whatsapp.net'");
  const port = servers.panel.address().port;
  const H = { 'x-wakil': '1' };
  const b = await (await post(port, '/api/bookings', { contact_id: c.id, hotel: 'Swissôtel Makkah', city: 'makkah', check_in: '2027-03-10', check_out: '2027-03-15', total: 9000, currency: 'SAR', commission: 700, status: 'confirmed' }, H)).json();
  const pay = db.get("SELECT * FROM payments WHERE status = 'claimed'");
  await post(port, '/api/payments', { id: pay.id, status: 'confirmed', amount: 4000 }, H);
  const s = stats(30);
  assert.equal(s.totals.bookings, 1);
  assert.equal(s.totals.revenue.SAR, 9000);
  assert.equal(s.totals.paid.SAR, 4000);
  assert.equal(s.totals.debts.SAR, 5000, 'долг = сумма брони − подтверждённые оплаты');
  assert.equal(db.get('SELECT nights FROM bookings WHERE id = ?', b.id).nights, 5);
  assert.ok(s.hotels.find((h) => h.hotel === 'Swissôtel Makkah' && h.bookings === 1 && h.interest === 1));
  const csv = exportCsv('bookings');
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /Swissôtel Makkah/);
});

test('ответ из нескольких сообщений подряд (как пишет владелец) уходит отдельными сообщениями', async () => {
  aiReply = base({ reply: 'Ва алейкум ассалам 🤍\n---\nНа какие даты?' });
  const n = sent.length;
  hub.inbound({ channel: 'waqr', chatId: '79281239999@s.whatsapp.net', phone: '79281239999', text: 'Салам', extId: 'split1', at: Date.now() });
  await until(() => sent.length >= n + 2);
  assert.deepEqual(sent.slice(n).map((s) => s.text), ['Ва алейкум ассалам 🤍', 'На какие даты?']);
  const c = db.get("SELECT id FROM contacts WHERE chat_id = '79281239999@s.whatsapp.net'");
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE contact_id = ? AND author = 'bot'", c.id).n, 2);
});

test('мелочи: разбор JSON, строгая схема, деление длинного текста', () => {
  assert.deepEqual(parseJson('Вот ответ:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('текст {"a":2} текст'), { a: 2 });
  const st = strictSchema(agent.REPLY_SCHEMA);
  assert.equal(st.additionalProperties, false);
  assert.deepEqual(st.properties.handoff.required, ['needed', 'reason', 'urgency']);
  const parts = hub.splitText('а'.repeat(500) + '\n\n' + 'б'.repeat(700), 950);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 950));
});
