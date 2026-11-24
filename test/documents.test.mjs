// Документы для обучения: чтение PDF, Word, Excel, текста и разбор подменённым ИИ.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wakil-docs-'));
process.env.WAKIL_DATA = DIR;
const { loadConfig, patchConfig, paths } = await import('../src/config.mjs');
const db = await import('../src/db.mjs');
const { setMockAi } = await import('../src/ai/providers.mjs');
const { ensureKnowledge, listKnowledge, findHotel, saveHotel } = await import('../src/knowledge.mjs');
const docs = await import('../src/documents.mjs');

let aiCalls = [];
let aiAnswer = null;
before(() => {
  loadConfig();
  patchConfig({ business: { name: 'Умра-Сервис' } });
  db.openDb(paths.db);
  ensureKnowledge();
  setMockAi(async (o) => { aiCalls.push(o); return typeof aiAnswer === 'function' ? aiAnswer(o) : { ok: true, data: aiAnswer }; });
});
after(() => { db.closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

/** Простой .zip без сжатия — чтобы собрать .docx и .xlsx прямо в проверке. */
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), n = Buffer.from(name, 'utf8'), crc = zlib.crc32(data);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, n, data); centrals.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const W = (body) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
const p = (t) => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="100"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const tc = (t) => `<w:tc><w:tcPr/>${p(t)}</w:tc>`;
const DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': W(p('Прайс на Рамадан &amp; Шавваль') + p('Цены до 31.03.2027') +
    `<w:tbl><w:tr>${tc('Отель')}${tc('Двухместный')}</w:tr><w:tr>${tc('Swissôtel Makkah')}${tc('1450 SAR')}</w:tr></w:tbl>` + p('Трансфер Джидда — Мекка: 250 SAR')),
});
const XLSX = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Мекка" sheetId="1" r:id="rId1"/><sheet name="Скрытый" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Target="worksheets/sheet2.xml" Id="rId2" Type="ws"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Отель</t></si><si><t>Цена</t></si><si><t>Действует до</t></si><si><r><t>Pullman </t></r><r><t>Zamzam</t></r></si><si><t>секрет</t></si></sst>',
  'xl/styles.xml': '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1300</v></c><c r="D2" s="1"><v>46477</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Итого</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row></sheetData></worksheet>',
});

test('Word: абзацы, таблицы, знаки — читаются', () => {
  const t = docs.docxText(DOCX);
  assert.match(t, /Прайс на Рамадан & Шавваль/);
  assert.match(t, /Swissôtel Makkah \| 1450 SAR/);
  assert.match(t, /Трансфер Джидда — Мекка: 250 SAR/);
  assert.doesNotMatch(t, /\t/, 'позиции табуляции из настроек абзаца — не текст');
});

test('Excel: листы, общие строки, даты, скрытые листы не берём', () => {
  const t = docs.xlsxText(XLSX);
  assert.match(t, /Лист «Мекка»/);
  assert.match(t, /Отель \| Цена \|  \| Действует до/);
  assert.match(t, /Pullman Zamzam \| 1300 \|  \| 2027-03-31/);
  assert.match(t, /Итого \| да/);
  assert.doesNotMatch(t, /секрет/);
});

test('PDF с текстом читается (кириллица, таблица)', async () => {
  const r = await docs.pdfText(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'price.pdf')));
  assert.equal(r.pages, 1);
  assert.match(r.text, /Прайс-лист Умра-Сервис/);
  assert.match(r.text, /31\.03\.2027/);
  assert.match(r.text, /Трансфер Джидда — Мекка: 250 SAR/);
});

test('текст в кодировке Windows (cp1251) и UTF-8 с BOM', () => {
  const cp = Buffer.from([0xcf, 0xf0, 0xe0, 0xe9, 0xf1]); // «Прайс» в cp1251
  assert.equal(docs.decodeText(cp), 'Прайс');
  assert.equal(docs.decodeText(Buffer.from('﻿Цены', 'utf8')), 'Цены');
});

test('неподходящие файлы: понятная подсказка, экспорт чата не путаем с документом', () => {
  assert.match(docs.docProblem('прайс.pages'), /PDF/);
  assert.match(docs.docProblem('photo.heic'), /JPG/);
  assert.equal(docs.docProblem('прайс.xlsx'), '');
  const chat = Array.from({ length: 6 }, (_, i) => `12.03.2026, 10:0${i} - ${i % 2 ? 'Ахмед' : 'Хасан'}: сообщение ${i}`).join('\n');
  assert.throws(() => docs.addDocument({ name: 'WhatsApp Chat with Ахмед.txt', buf: Buffer.from(chat) }), /экспорт чата/);
});

test('документ Word → отели в карточки, остальное — в знания, вопросы владельцу', async () => {
  saveHotel({ name: 'Swissotel Makkah', city: 'makkah', stars: 5 });
  aiCalls = [];
  aiAnswer = {
    title: 'Прайс Рамадан 2027', summary: 'Прайс на Рамадан: цены двух отелей и трансфер.',
    knowledge: '- Трансфер Джидда — Мекка: 250 SAR за машину.\n- Предоплата 50%.',
    hotels: [
      { name: 'Swissotel Makkah', city: null, stars: null, distance: '100 м', area: null, description: null, prices: 'Двухместный — 1450 SAR/ночь', prices_until: '2027-03-31', private_note: null, active: null },
      { name: 'Pullman Zamzam Makkah', city: 'makkah', stars: 5, distance: null, area: null, description: null, prices: 'Двухместный — 1300 SAR/ночь', prices_until: '31.03.2027', private_note: null, active: null },
    ],
    questions: ['Цены за номер или за человека?'],
  };
  const r = docs.addDocument({ name: 'Прайс Рамадан.docx', buf: DOCX, via: 'panel' });
  const d = await r.done;
  assert.equal(d.status, 'done', d.error);
  assert.match(aiCalls[0].prompt, /Swissôtel Makkah \| 1450 SAR/, 'ИИ получил текст документа');
  assert.match(aiCalls[0].system, /Swissotel Makkah — Мекка/, 'ИИ знает уже известные отели');
  const sw = findHotel('Swissotel Makkah');
  assert.equal(sw.prices_until, '2027-03-31');
  assert.equal(sw.stars, 5, 'null не стирает известное');
  const pz = findHotel('Pullman Zamzam Makkah');
  assert.ok(pz, 'новый отель добавлен');
  assert.ok(!pz.prices_until, 'дату не в формате ГГГГ-ММ-ДД не записываем');
  const k = listKnowledge().find((f) => f.name === 'Документ — Прайс Рамадан 2027.md');
  assert.ok(k, 'справка в знаниях');
  assert.match(k.text, /Предоплата 50%/);
  assert.deepEqual(d.result.hotelsAdded, ['Pullman Zamzam Makkah']);
  assert.deepEqual(d.result.hotelsUpdated, ['Swissotel Makkah']);
  const txt = docs.resultText(d);
  assert.match(txt, /Добавил отели: Pullman Zamzam Makkah/);
  assert.match(txt, /❓ Цены за номер или за человека\?/);
  const hist = db.kvGet('teach_history', []);
  assert.match(hist.at(-1).text, /Цены за номер или за человека/, 'итог — в истории чата-учителя: ответ владельца бот поймёт');
  // тот же файл ещё раз — не читаем заново
  const again = docs.addDocument({ name: 'копия.docx', buf: DOCX });
  assert.equal(again.duplicate, true);
  assert.equal(aiCalls.length, 1);
  // удаление: справка уходит, отели остаются
  docs.deleteDocument(d.id);
  assert.ok(!listKnowledge().some((f) => f.name.startsWith('Документ — Прайс')));
  assert.ok(findHotel('Pullman Zamzam Makkah'));
  assert.equal(docs.listDocuments().length, 0);
});

test('PDF для Claude уходит целиком (видны таблицы и сканы); ошибка ИИ — понятная, можно повторить', async () => {
  aiCalls = [];
  aiAnswer = () => ({ ok: false, code: 'limit', message: 'limit' });
  const r = docs.addDocument({ name: 'price.pdf', buf: fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'price.pdf')), via: 'telegram', note: 'цены до 31 марта' });
  let d = await r.done;
  assert.equal(aiCalls[0].images[0].mime, 'application/pdf');
  assert.match(aiCalls[0].system, /цены до 31 марта/, 'подпись владельца к файлу');
  assert.equal(d.status, 'error');
  assert.match(d.error, /лимит/);
  aiAnswer = { title: 'Прайс', summary: 'Прайс', knowledge: '', hotels: [], questions: [] };
  d = await docs.processDocument(d.id);
  assert.equal(d.status, 'done');
  assert.match(docs.resultText(d), /Полезного для клиентов в нём не нашёл/);
});

test('новая версия документа заменяет старую: у бота не остаётся двух разных условий', async () => {
  aiCalls = [];
  aiAnswer = { title: 'Условия оплаты', summary: 'Условия', knowledge: '- Предоплата 30%.', hotels: [], questions: [], replaces: [] };
  const a = await docs.addDocument({ name: 'условия.txt', buf: Buffer.from('Предоплата 30% при бронировании') }).done;
  assert.equal(a.knowledge_file, 'Документ — Условия оплаты.md');
  aiAnswer = (o) => ({ ok: true, data: { title: 'Условия оплаты', summary: 'Новые условия', knowledge: '- Предоплата 50%.', hotels: [], questions: [], replaces: [Number(/(\d+): «Условия оплаты»/.exec(o.system)?.[1]), 999] } });
  const b = await docs.addDocument({ name: 'условия 2027.txt', buf: Buffer.from('Предоплата 50% при бронировании') }).done;
  assert.match(aiCalls[1].system, /«Условия оплаты» — условия\.txt/, 'ИИ видит старые документы');
  const old = docs.listDocuments().find((x) => x.id === a.id);
  assert.equal(old.status, 'replaced');
  const ks = listKnowledge().filter((f) => f.name.startsWith('Документ — Условия'));
  assert.deepEqual(ks.map((f) => f.name), ['Документ — Условия оплаты.md']);
  assert.match(ks[0].text, /Предоплата 50%/);
  assert.deepEqual(b.result.replaced.map((x) => x.id), [a.id], 'несуществующий номер пропущен');
  assert.match(docs.resultText(b), /новая версия: «Условия оплаты» \(условия\.txt\)/);
});
