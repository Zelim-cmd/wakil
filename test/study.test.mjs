// Изучение прошлой переписки: разбор файлов, загрузка истории, изучение стиля (ИИ подменён).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wakil-study-'));
process.env.WAKIL_DATA = DIR;
const { loadConfig, patchConfig, paths } = await import('../src/config.mjs');
const db = await import('../src/db.mjs');
const { setMockAi } = await import('../src/ai/providers.mjs');
const hub = await import('../src/channels/hub.mjs');
const agent = await import('../src/agent.mjs');
const study = await import('../src/study.mjs');
const { stats } = await import('../src/analytics.mjs');
const { onHistory } = await import('../src/channels/wa-qr.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(20); } return fn(); }
const sent = [];
let aiCalls = [];
let studyDelay = 0;

const REPLY = { reply: 'Ассаляму алейкум, брат! 🤲', language: 'ru', client_name: null, handoff: { needed: false, reason: '', urgency: 'low' },
  facts: { city: null, hotels: [], check_in: null, check_out: null, nights: null, guests: null, rooms: null, room_type: null, meals: null, budget: null, budget_note: null, currency: null, trip_type: null, notes: null },
  stage: 'consulting', lost_reason: null, payment_claim: { claimed: false, amount: null, currency: null }, unanswered: [], summary: '' };

before(() => {
  loadConfig();
  patchConfig({ behavior: { botEnabled: true, debounceSec: 0, humanDelay: false, studyRetrySec: 0.2 }, study: { months: 120 } });
  db.openDb(paths.db);
  hub.onInbound(agent.handleInbound);
  hub.register('waqr', { send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, extId: 's' + sent.length }; }, status: () => ({ state: 'connected' }) });
  setMockAi(async (o) => {
    aiCalls.push(o);
    if (o.purpose === 'study' && !o.smart) {
      if (studyDelay) await sleep(studyDelay);
      return { ok: true, data: { relevant: [1, 2], style: 'Пишет коротко, «брат», эмодзи 🤲', examples: [{ situation: 'первое сообщение', client: 'Салам, есть отель?', owner: 'Ва алейкум салам, брат! Есть, на какие даты? 🤲 Карта 4276 1234 5678 9012' }], facts: [{ kind: 'faq', text: 'Предоплата 30%, остаток при заселении' }], hotels: ['Swissôtel'] } };
    }
    if (o.purpose === 'study') return { ok: true, data: { profile: 'Здоровайся: «Ва алейкум салам, брат!». Пиши коротко.', examples: [{ situation: 'первое сообщение', client: 'Салам, есть отель?', owner: 'Ва алейкум салам, брат! Есть, на какие даты? 🤲 Карта 4276 1234 5678 9012' }], facts: [{ kind: 'faq', text: 'Предоплата 30%, остаток при заселении' }], report: 'Вы пишете коротко и тепло.' } };
    return { ok: true, data: REPLY };
  });
});
after(async () => { await sleep(400); db.closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); setTimeout(() => process.exit(0), 50); });

const IOS = `[12.03.25, 14:05:33] Ахмед: ‎Сообщения и звонки защищены сквозным шифрованием.
[12.03.25, 14:05:40] Ахмед: Салам, нужен отель в Мекке
на 5 ночей, нас 4
[12.03.25, 14:07:02] Зелимхан Умра: Ва алейкум салам, брат! На какие даты? 🤲
[12.03.25, 14:08:10] Ахмед: ‎изображение отсутствует
[13.03.25, 09:00:00] Зелимхан Умра: Есть Swissôtel, 900 риялов`;
const ANDROID = `20.04.2025, 10:15 - Сообщения и звонки защищены сквозным шифрованием. Нажмите, чтобы узнать подробнее.
20.04.2025, 10:15 - Мадина: Здравствуйте, сколько стоит Хилтон?
20.04.2025, 10:20 - Зелимхан Умра: Ассаляму алейкум, сестра! Хилтон 650 за ночь 🌙
20.04.2025, 10:21 - Мадина: Дорого(
20.04.2025, 10:25 - Зелимхан Умра: Есть вариант подешевле, ин ша Аллах подберём`;

test('экспорт WhatsApp с iPhone: многострочные сообщения, служебные строки и вложения', () => {
  const r = study.parseWhatsAppTxt(IOS, 'WhatsApp Chat - Ахмед.zip');
  assert.equal(r.title, 'Ахмед');
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[0].text, 'Салам, нужен отель в Мекке\nна 5 ночей, нас 4');
  assert.equal(r.messages[2].text, '[вложение]');
  assert.equal(new Date(r.messages[3].at + 3 * 3600000).getUTCDate(), 13, 'день и месяц не перепутаны');
});

test('экспорт WhatsApp с Android и американский формат даты', () => {
  const r = study.parseWhatsAppTxt(ANDROID, 'Чат WhatsApp с Мадина.txt');
  assert.equal(r.title, 'Мадина');
  assert.equal(r.messages.length, 4);
  const us = study.parseWhatsAppTxt('3/14/25, 2:05 PM - Ali: Hi\n3/14/25, 2:06 PM - Me: Hello brother', 'x.txt');
  assert.equal(us.messages.length, 2);
  const d = new Date(us.messages[0].at + 3 * 3600000);
  assert.equal(d.getUTCMonth(), 2); assert.equal(d.getUTCDate(), 14); assert.equal(d.getUTCHours(), 14);
});

test('выгрузка Instagram: починка кодировки', () => {
  const broken = (s) => Buffer.from(s, 'utf8').toString('latin1');
  const r = study.parseInstagramJson({ title: broken('Умар'), participants: [], messages: [
    { sender_name: broken('Умар'), timestamp_ms: 2000, content: broken('Салам, цены?') },
    { sender_name: 'umra_service', timestamp_ms: 3000, content: broken('Ва алейкум салам!') },
    { sender_name: broken('Умар'), timestamp_ms: 4000, content: 'Liked a message' }] });
  assert.equal(r.title, 'Умар');
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].text, 'Салам, цены?');
});

function makeZip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(text)); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(Buffer.byteLength(text), 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(Buffer.byteLength(text), 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('загрузка: zip с iPhone + txt с Android → владелец определён, чаты в архиве', () => {
  study.stageUpload('b1', 'WhatsApp Chat - Ахмед.zip', makeZip({ '_chat.txt': IOS, 'IMG-1.jpg': 'x' }));
  study.stageUpload('b1', 'Чат WhatsApp с Мадина.txt', Buffer.from(ANDROID));
  const r = study.finishUpload('b1');
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'Зелимхан Умра');
  assert.equal(r.chats, 2);
  const c = db.get("SELECT * FROM contacts WHERE name = 'Ахмед'");
  assert.equal(c.imported, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE contact_id = ? AND author = 'owner'", c.id).n, 2);
  assert.equal(stats(0).totals.newContacts, 0, 'архив не считается новыми клиентами');
  // повторная загрузка тех же файлов ничего не дублирует
  study.stageUpload('b2', 'Чат WhatsApp с Мадина.txt', Buffer.from(ANDROID));
  assert.equal(study.finishUpload('b2').messages, 0);
});

test('один чат без подсказки → спрашиваем, кто владелец', () => {
  study.stageUpload('b3', 'chat.txt', Buffer.from('01.05.2025, 10:00 - Ислам: Салам\n01.05.2025, 10:01 - Зелимхан Умра: Ва алейкум'));
  patchConfig({ business: { ownerName: '' } });
  db.run("DELETE FROM kv WHERE key = 'export_owner_name'");
  const r = study.finishUpload('b3');
  assert.equal(r.needOwner, true);
  assert.deepEqual(r.authors.sort(), ['Зелимхан Умра', 'Ислам']);
  const r2 = study.finishUpload('b3', 'Зелимхан Умра');
  assert.equal(r2.ok, true);
});

test('история WhatsApp при подключении: личные чаты, скрытые номера (@lid), группы пропускаются', async () => {
  const t = Math.floor(Date.now() / 1000) - 86400;
  await onHistory({}, {
    chats: [{ id: '79280001111@s.whatsapp.net', name: 'Руслан' }],
    contacts: [],
    lidPnMappings: [{ lid: '1234567@lid', pn: '79280002222@s.whatsapp.net' }],
    messages: [
      { key: { remoteJid: '79280001111@s.whatsapp.net', fromMe: false, id: 'h1' }, message: { conversation: 'Салам, отель в Медине?' }, messageTimestamp: t, pushName: 'Руслан' },
      { key: { remoteJid: '79280001111@s.whatsapp.net', fromMe: true, id: 'h2' }, message: { conversation: 'Ва алейкум салам, брат!' }, messageTimestamp: t + 60 },
      { key: { remoteJid: '1234567@lid', fromMe: false, id: 'h3' }, message: { extendedTextMessage: { text: 'Сколько стоит?' } }, messageTimestamp: t, pushName: 'Лейла' },
      { key: { remoteJid: '1203630@g.us', fromMe: false, id: 'h4', participant: 'x@s.whatsapp.net' }, message: { conversation: 'группа' }, messageTimestamp: t },
    ],
  });
  const r = db.get("SELECT * FROM contacts WHERE chat_id = '79280001111@s.whatsapp.net'");
  assert.equal(r.name, 'Руслан'); assert.equal(r.imported, 1); assert.equal(r.phone, '79280001111');
  assert.ok(db.get("SELECT id FROM contacts WHERE chat_id = '79280002222@s.whatsapp.net'"), 'скрытый номер сведён к настоящему');
  assert.equal(db.get("SELECT COUNT(*) n FROM messages WHERE ext_id = 'h4'").n, 0);
  assert.equal(db.get("SELECT author FROM messages WHERE ext_id = 'h2'").author, 'owner');
});

test('изучение: профиль, образцы без реквизитов, факты на одобрение, бот пишет по профилю', async () => {
  const r = await study.runStudy({ mode: 'full' });
  assert.equal(r.ok, true, r.error);
  const p = db.kvGet('style_profile');
  assert.match(p.text, /брат/);
  const ex = db.kvGet('style_examples');
  assert.equal(ex.length, 1);
  assert.doesNotMatch(ex[0].owner, /4276/, 'номер карты скрыт');
  assert.match(ex[0].owner, /\[номер карты\]/);
  assert.ok(db.get("SELECT id FROM lessons WHERE source = 'history' AND status = 'proposed'"), 'факты из переписки ждут одобрения');
  const mapCall = aiCalls.find((c) => c.purpose === 'study' && !c.smart);
  assert.match(mapCall.prompt, /Владелец: Ва алейкум салам, брат/);
  assert.doesNotMatch(mapCall.prompt, /79280001111/, 'телефоны в ИИ не уходят');
  const sys = agent.buildSystem();
  assert.match(sys, /КАК ПИШЕТ ВЛАДЕЛЕЦ[\s\S]*Ва алейкум салам, брат/);
  assert.match(sys, /устарели — их НЕ используй/);
});

test('пока идёт изучение, бот не отвечает клиенту; после — отвечает', async () => {
  studyDelay = 800;
  const running = study.runStudy({ mode: 'full' });
  await sleep(50);
  assert.equal(study.isStudying(), true);
  const n = sent.length;
  hub.inbound({ channel: 'waqr', chatId: '79285550000@s.whatsapp.net', phone: '79285550000', text: 'Салам!', extId: 'live1', at: Date.now() });
  await sleep(400);
  assert.equal(sent.length, n, 'ждёт окончания изучения');
  await running;
  studyDelay = 0;
  await until(() => sent.length > n);
  assert.equal(sent.at(-1).text, 'Ассаляму алейкум, брат! 🤲');
});

test('клиент из архива написал снова — он больше не архивный', async () => {
  hub.inbound({ channel: 'waqr', chatId: '79280001111@s.whatsapp.net', phone: '79280001111', text: 'Салам, снова я', extId: 'live2', at: Date.now() });
  await until(() => db.get("SELECT imported FROM contacts WHERE chat_id = '79280001111@s.whatsapp.net'").imported === 0);
  assert.equal(db.get("SELECT imported FROM contacts WHERE chat_id = '79280001111@s.whatsapp.net'").imported, 0);
});

test('скрытие реквизитов', () => {
  const t = study.redact('Карта 4276 1234 5678 9012, тел +7 928 123-45-67, IBAN SA03 8000 0000 6080 1016 7519, цена 1 200 SAR');
  assert.doesNotMatch(t, /4276|928|SA03/);
  assert.match(t, /1 200 SAR/, 'цены не трогаем');
});
