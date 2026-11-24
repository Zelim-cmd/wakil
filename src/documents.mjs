// Документы для обучения: прайсы, условия бронирования и оплаты, описания отелей, инструкции.
// Файл → текст (PDF, Word, Excel, текст; фото — картинкой; PDF для Claude — целиком, так он видит и сканы, и таблицы)
// → ИИ разбирает: цены — в карточки отелей, остальное — в файл знаний «Документ — …» (его видно и можно править
// на странице «Отели и знания»). Оригинал хранится в data/documents, чтобы можно было перечитать.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config, paths, log } from './config.mjs';
import { get, all, run, insert, update, addEvent, kvGet, kvSet } from './db.mjs';
import { ask, canReadPdf } from './ai/providers.mjs';
import { listHotels, mergeHotels, listKnowledge, saveKnowledge, deleteKnowledge, HOTEL_ITEM_SCHEMA, CITY_LABEL } from './knowledge.mjs';
import { readZip, parseWhatsAppTxt } from './study.mjs';

export const DOC_ACCEPT = '.pdf,.docx,.xlsx,.xlsm,.txt,.md,.csv,.tsv,.html,.htm,.rtf,.doc,.odt,.jpg,.jpeg,.png,.webp,.gif';
const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'json']);
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const MAC_CONVERT = new Set(['doc', 'rtf', 'odt', 'rtfd', 'webarchive']); // на Mac их понимает встроенная программа textutil
const MAX_CHARS = 120000;      // больше в одну просьбу к ИИ не отправляем
const MAX_PDF_PAGES = 30;      // до стольких страниц PDF отдаём Claude целиком (видит таблицы и сканы)
const MAX_IMAGE = 4.5 * 1024 * 1024;
export const MAX_DOC_BYTES = 50 * 1024 * 1024;

const ext = (name) => path.extname(String(name || '')).slice(1).toLowerCase();

/** Можно ли прочитать такой файл. Возвращает текст ошибки для владельца или ''. */
export function docProblem(name) {
  const e = ext(name);
  if (TEXT_EXT.has(e) || IMAGE_MIME[e] || ['pdf', 'docx', 'xlsx', 'xlsm', 'html', 'htm'].includes(e)) return '';
  if (MAC_CONVERT.has(e) && process.platform === 'darwin') return '';
  if (['doc', 'rtf', 'odt'].includes(e)) return 'Этот формат я читаю только на Mac. Сохраните файл как PDF или Word (.docx): «Файл → Сохранить как».';
  if (e === 'xls' || e === 'ods' || e === 'numbers') return 'Сохраните таблицу как Excel (.xlsx) или PDF: «Файл → Сохранить как» (в Numbers — «Файл → Экспортировать → Excel»).';
  if (e === 'pages' || e === 'key' || e === 'ppt' || e === 'pptx') return 'Сохраните файл как PDF («Файл → Экспортировать → PDF») и пришлите снова.';
  if (e === 'heic' || e === 'heif') return 'Фото в формате HEIC я не читаю. Пришлите его как JPG или PNG (или обычной фотографией в Telegram).';
  if (e === 'zip') return 'Архив .zip — это экспорт чатов? Загрузите его в «Как вы пишете клиентам». Документы присылайте по одному файлу.';
  return 'Такой файл я не читаю. Подойдут PDF, Word (.docx), Excel (.xlsx), текст или фото.';
}

// ======================= файл → текст =======================

/** Текстовый файл: UTF-8, UTF-16 или кириллица Windows (cp1251). */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch {}
  return new TextDecoder('windows-1251').decode(buf);
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const xmlText = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()] ?? m;
  const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  try { return String.fromCodePoint(n); } catch { return ''; }
});
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const tidy = (s) => String(s).replace(/\r\n?/g, '\n').replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Word (.docx): абзацы, табуляции, таблицы (ячейки через « | »). */
export function docxText(buf) {
  const files = readZip(buf, /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/i);
  const main = files.find((f) => /document\.xml$/i.test(f.name));
  if (!main) throw new Error('Файл не похож на документ Word (.docx).');
  const parts = [main, ...files.filter((f) => f !== main && /header|footer/i.test(f.name)), ...files.filter((f) => /notes/i.test(f.name))];
  return tidy(parts.map((f) => {
    const xml = f.data.toString('utf8').replace(/<w:tabs>[\s\S]*?<\/w:tabs>/g, '').replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '').replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, '');
    let out = '';
    for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g)) {
      if (m[1] !== undefined) out += xmlText(m[1]);
      else if (m[0].startsWith('<w:tab')) out += '\t';
      else if (m[0] === '</w:tc>') out += ' | ';
      else out += '\n';
    }
    return out.replace(/\n \| /g, ' | ').replace(/ \| \n/g, '\n');
  }).join('\n\n'));
}

const colIndex = (ref) => { let n = 0; for (const ch of String(ref || '').replace(/\d+$/, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const serialDate = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)).toISOString().slice(0, 10);

/** Excel (.xlsx): все видимые листы, строки — ячейки через « | », даты — ГГГГ-ММ-ДД. */
export function xlsxText(buf) {
  const files = readZip(buf, /^xl\/(sharedStrings|workbook|styles)\.xml$|^xl\/worksheets\/[^/]+\.xml$|^xl\/_rels\/workbook\.xml\.rels$/i);
  const by = Object.fromEntries(files.map((f) => [f.name.toLowerCase(), f.data.toString('utf8')]));
  if (!by['xl/workbook.xml']) throw new Error('Файл не похож на таблицу Excel (.xlsx).');
  const shared = [...(by['xl/sharedstrings.xml'] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => xmlText(t[1])).join(''));
  // какие ячейки — даты (Excel хранит дату числом и помечает форматом)
  const styles = by['xl/styles.xml'] || '';
  const custom = Object.fromEntries([...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [attr(m[0], 'numFmtId'), xmlText(attr(m[0], 'formatCode') || '')]));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '';
  const isDate = [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = attr(m[0], 'numFmtId') || '0'; const n = Number(id);
    if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47)) return true;
    const code = (custom[id] || '').replace(/\[[^\]]*\]|"[^"]*"|\\./g, '');
    return /[dy]/i.test(code) || /m{3,}/i.test(code) || /(^|[^h:])m+[./-]/i.test(code);
  });
  const rels = Object.fromEntries([...(by['xl/_rels/workbook.xml.rels'] || '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  let sheets = [...by['xl/workbook.xml'].matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: xmlText(attr(m[0], 'name') || ''),
    file: 'xl/' + String(rels[attr(m[0], 'r:id')] || '').replace(/^\/?(xl\/)?/, '').toLowerCase(),
    hidden: /state="(hidden|veryHidden)"/.test(m[0]),
  }));
  if (!sheets.some((s) => by[s.file])) sheets = Object.keys(by).filter((k) => k.startsWith('xl/worksheets/')).sort().map((file, i) => ({ name: `Лист ${i + 1}`, file }));
  const out = [];
  for (const sh of sheets) {
    const xml = by[sh.file];
    if (!xml || sh.hidden) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      let next = 0;
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1], inner = c[2] || '';
        const ref = attr(a, 'r');
        const col = ref ? colIndex(ref) : next;
        next = col + 1;
        const t = attr(a, 't');
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => xmlText(x[1])).join('');
        else if (t === 'b') val = v === '1' ? 'да' : 'нет';
        else if (t === 'e') val = '';
        else if (v !== undefined) {
          val = xmlText(v);
          if (t !== 'str' && isDate[Number(attr(a, 's') || 0)] && /^\d+(\.\d+)?$/.test(val) && Number(val) > 59 && Number(val) < 2958466) val = serialDate(Number(val));
          else if (/^-?\d+\.\d{6,}$/.test(val)) val = String(Math.round(Number(val) * 100) / 100);
        }
        val = val.replace(/\s+/g, ' ').trim();
        if (val) cells[col] = val;
      }
      if (cells.length) rows.push(Array.from(cells, (x) => x ?? '').join(' | '));
    }
    if (rows.length) out.push(`## Лист «${sh.name}»\n${rows.join('\n')}`);
  }
  return tidy(out.join('\n\n'));
}

/** Страница .html → текст. */
export function htmlText(s) {
  return tidy(xmlText(String(s)
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')).replace(/ \| \n/g, '\n'));
}

export async function pdfText(buf) {
  let unpdf;
  try { unpdf = await import('unpdf'); } catch { return { text: '', pages: 0 }; }
  let pdf;
  try { pdf = await unpdf.getDocumentProxy(new Uint8Array(buf)); } catch (e) {
    if (/password/i.test(e?.name + e?.message)) throw new Error('PDF защищён паролем. Снимите пароль (или распечатайте в новый PDF) и пришлите снова.');
    throw new Error('Не получилось открыть PDF — возможно, файл повреждён.');
  }
  const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text || '')];
  return { pages: totalPages, text: tidy(pages.map((t, i) => (totalPages > 1 ? `--- страница ${i + 1} ---\n${t}` : t)).join('\n\n')) };
}

const execFileP = (cmd, args, o = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...o }, (e, out) => (e ? rej(e) : res(out))));

/**
 * Прочитать файл. → { text, images: [{path, mime}], pages, mode: 'text'|'pdf'|'image', truncated }
 * images — то, что ИИ посмотрит сам (фото, PDF целиком для Claude).
 */
export async function readDocument(file, name) {
  const e = ext(name);
  const buf = fs.readFileSync(file);
  let text = '', pages = 0, images = [], mode = 'text';
  if (IMAGE_MIME[e]) {
    let p = file;
    if (buf.length > MAX_IMAGE) {
      if (process.platform !== 'darwin') throw new Error('Фото больше 4,5 МБ. Уменьшите его или пришлите через Telegram обычной фотографией (он сжимает сам).');
      p = path.join(paths.aiWork, `doc-${Date.now()}.jpg`);
      fs.mkdirSync(paths.aiWork, { recursive: true });
      await execFileP('sips', ['-Z', '2400', '-s', 'format', 'jpeg', file, '--out', p]);
    }
    return { text: '', images: [{ path: p, mime: p === file ? IMAGE_MIME[e] : 'image/jpeg' }], pages: 1, mode: 'image', truncated: false };
  }
  if (e === 'pdf') {
    ({ text, pages } = await pdfText(buf));
    const letters = text.replace(/[\s\d\-–—|.,:;]+/g, '').length;
    const scan = letters < Math.max(40, 25 * (pages || 1));
    if (canReadPdf() && buf.length <= 25 * 1024 * 1024 && (pages || 1) <= MAX_PDF_PAGES) {
      return { text: '', images: [{ path: file, mime: 'application/pdf' }], pages, mode: 'pdf', truncated: false };
    }
    if (scan) {
      throw new Error(canReadPdf()
        ? `Это скан без текста, и в нём больше ${MAX_PDF_PAGES} страниц. Пришлите нужные страницы отдельно или фото страниц.`
        : 'Это скан без текста. Выбранный ИИ не читает сканы PDF: пришлите фото страниц (до 5 штук) — их он прочитает.');
    }
  } else if (e === 'docx') text = docxText(buf);
  else if (e === 'xlsx' || e === 'xlsm') text = xlsxText(buf);
  else if (e === 'html' || e === 'htm') text = htmlText(decodeText(buf));
  else if (MAC_CONVERT.has(e)) {
    if (process.platform !== 'darwin') throw new Error(docProblem(name));
    text = tidy(await execFileP('textutil', ['-convert', 'txt', '-stdout', file]));
  } else text = tidy(decodeText(buf));
  if (!text.replace(/\s+/g, '')) throw new Error('В файле не нашлось текста.');
  const truncated = text.length > MAX_CHARS;
  return { text: truncated ? text.slice(0, MAX_CHARS) : text, images, pages, mode, truncated };
}

/** Похоже ли на экспорт чата WhatsApp — такой файл нужен для изучения стиля, а не как документ. */
export function looksLikeChat(name, buf) {
  if (ext(name) !== 'txt') return false;
  try { return parseWhatsAppTxt(decodeText(buf), name).messages.length >= 5; } catch { return false; }
}

// ======================= ИИ разбирает документ =======================
const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Короткое название документа по-русски, 2–5 слов: «Прайс Рамадан 2027», «Условия оплаты»' },
    summary: { type: 'string', description: 'Владельцу: что это за документ и что ты из него взял, 1–3 строки' },
    knowledge: { type: 'string', description: 'Справка для бота по остальному содержимому (не цены отелей) — или пустая строка' },
    hotels: { type: 'array', items: HOTEL_ITEM_SCHEMA },
    questions: { type: 'array', items: { type: 'string' }, description: 'Что владельцу уточнить, чтобы бот не ошибся (не больше 3)' },
    replaces: { type: 'array', items: { type: 'integer' }, description: 'Номера старых документов из списка, которые этот целиком заменяет (новая версия того же прайса или тех же условий, включая их копии), иначе пустой список' },
  },
  required: ['title', 'summary', 'knowledge', 'hotels', 'questions', 'replaces'],
};

function docSystem(d) {
  const note = d.note;
  const b = config().business;
  const older = all("SELECT id, name, title, summary, created_at FROM documents WHERE status = 'done' AND id != ? AND created_at <= ? ORDER BY id DESC LIMIT 30", d.id, d.created_at);
  const hotels = listHotels().map((h) => `${h.name} — ${CITY_LABEL[h.city] || h.city || '?'}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  return `Ты обучаешь ИИ-консультанта компании «${b.name || 'турагентство'}» — он отвечает паломникам про отели Мекки и Медины. Владелец прислал документ, чтобы бот знал то, что в нём написано. Разбери документ:

1. hotels — отели, которые бот может предлагать: название (как в документе), city (makkah | madinah), звёзды, расстояние до Харама, район, короткое описание. prices — все цены понятным текстом, по строке на вариант: «тип номера — цена валюта — за что (за ночь, за номер, с питанием…)», с сезонами и датами, если они есть. prices_until — до какой даты цены верны (ГГГГ-ММ-ДД), только если это сказано в документе или владельцем; иначе null. Поля, которых в документе нет, — null (уже известное не сотрётся). private_note — только то, что явно не для клиентов: комиссия, нетто-цены, контакты отеля. Если отелей с данными в документе нет — пустой список. Если отель уже есть в списке ниже под немного другим названием — пиши название из списка.
2. knowledge — справка для бота обо всём остальном полезном для клиентов: условия бронирования, оплаты и отмены, трансферы, визы, питание, правила, ответы на частые вопросы, указания менеджера, как отвечать. По-русски, коротко, по пунктам, до 5000 знаков. Не повторяй цены отелей из hotels. Реквизиты, номера карт и счетов, пароли и личные данные людей (паспорта, телефоны клиентов) НЕ переписывай — вместо реквизитов напиши «реквизиты присылает менеджер». Если ничего такого нет — пустая строка.
3. questions — что владельцу уточнить, чтобы бот не ошибся (например: до какой даты цены верны, в какой валюте, за ночь или за весь срок). Не больше 3, только важное.
4. title и summary — как описано в полях.
5. replaces — если этот документ — новая версия старых документов ниже (тот же прайс или те же условия, но обновлённые), перечисли номера ВСЕХ таких старых документов, включая их копии в других форматах: их справки уберутся, чтобы у бота не было двух разных версий. Если документ о другом или только дополняет старые — пустой список.

Бери только то, что написано в документе (и что сказал владелец), — ничего не додумывай. Документ на другом языке — knowledge всё равно по-русски, названия отелей как в документе. Если срок цен уже прошёл (сегодня ${today}) — всё равно запиши цены с prices_until: бот сам не назовёт устаревшие.${note ? `\n\nВладелец написал к документу: «${note}» — это важнее текста документа.` : ''}

Отели, которые уже есть у бота:
${hotels || '(пока нет)'}

Старые документы (номер: название — файл, дата — что в нём):
${older.map((o) => `${o.id}: «${o.title || o.name}» — ${o.name}, ${new Date(o.created_at).toISOString().slice(0, 10)} — ${String(o.summary || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') || '(нет)'}`;
}

function knowledgeName(title, id) {
  const base = `Документ — ${String(title || `№${id}`).replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 60) || `№${id}`}`;
  const taken = new Set(listKnowledge().map((f) => f.name));
  if (!taken.has(base + '.md')) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i}).md`)) return `${base} (${i})`;
}

const row = (id) => {
  const d = get('SELECT * FROM documents WHERE id = ?', id);
  if (d) { try { d.result = JSON.parse(d.result || '{}'); } catch { d.result = {}; } }
  return d;
};
const running = new Map(); // id → обещание разбора

/** Разобрать сохранённый документ (или перечитать). → строка документа. */
export function processDocument(id) {
  if (running.has(id)) return running.get(id);
  const p = (async () => {
    const d = row(id);
    if (!d) throw new Error('Нет такого документа');
    update('documents', id, { status: 'reading', error: '' });
    try {
      if (!d.file || !fs.existsSync(d.file)) throw new Error('Файл документа не найден — загрузите его заново.');
      const doc = await readDocument(d.file, d.name);
      const prompt = doc.text
        ? `Документ «${d.name}»${doc.pages > 1 ? `, страниц: ${doc.pages}` : ''}${doc.truncated ? ' (очень большой — ниже только начало)' : ''}:\n\n${doc.text}`
        : `Документ «${d.name}» — ${doc.mode === 'pdf' ? 'PDF во вложении' : 'изображение во вложении'}. Прочитай его.`;
      const r = await ask({ purpose: 'document', system: docSystem(d), prompt, schema: DOC_SCHEMA, images: doc.images, smart: true, timeoutMs: 600000, maxTokens: 16000 });
      for (const img of doc.images) if (img.path !== d.file) fs.rm(img.path, { force: true }, () => {});
      if (!r.ok) throw new Error(r.code === 'limit' ? 'Закончился лимит подписки ИИ — попробуйте позже.' : `ИИ не ответил: ${r.message}`);
      const a = r.data || {};
      const hotels = mergeHotels(a.hotels);
      // перечитываем — старая справка этого документа заменяется новой
      if (d.knowledge_file) deleteKnowledge(d.knowledge_file);
      // новая версия старого документа: старую справку убираем (сам файл остаётся — его можно перечитать)
      const replaced = [];
      for (const rid of [].concat(a.replaces ?? []).map(Number).filter(Boolean)) {
        const old = get("SELECT * FROM documents WHERE id = ? AND id != ? AND status = 'done' AND created_at <= ?", rid, id, d.created_at);
        if (!old) continue;
        if (old.knowledge_file) deleteKnowledge(old.knowledge_file);
        let oldResult = {}; try { oldResult = JSON.parse(old.result || '{}'); } catch {}
        update('documents', old.id, { status: 'replaced', knowledge_file: '', result: JSON.stringify({ ...oldResult, replacedBy: { id, name: d.name } }) });
        replaced.push({ id: old.id, name: old.name, title: old.title });
      }
      let kfile = '';
      const k = String(a.knowledge || '').trim();
      if (k) {
        kfile = knowledgeName(a.title, id) + '.md';
        saveKnowledge(kfile, `${k}\n\n_Из документа «${d.name}», загружен ${new Date(d.created_at).toLocaleDateString('ru-RU')}._\n`);
      }
      const result = {
        mode: doc.mode, pages: doc.pages, truncated: doc.truncated,
        hotelsAdded: hotels.filter((h) => h.isNew).map((h) => h.name),
        hotelsUpdated: hotels.filter((h) => !h.isNew).map((h) => h.name),
        questions: (a.questions || []).map(String).filter(Boolean).slice(0, 3),
        knowledgeChars: k.length,
        replaced,
      };
      update('documents', id, { status: 'done', title: String(a.title || '').slice(0, 120), summary: String(a.summary || '').slice(0, 1000), knowledge_file: kfile, result: JSON.stringify(result), done_at: Date.now() });
      addEvent('document', null, { name: d.name, hotels: hotels.length, knowledge: k.length });
      log(`Документ «${d.name}» изучен: отелей ${hotels.length}, справка ${k.length} знаков`);
      // в историю чата-учителя — чтобы ответ владельца на вопросы («цены до 31 марта») бот понял
      const done = row(id);
      kvSet('teach_history', [...kvGet('teach_history', []), { who: 'owner', text: `📄 Прислал документ «${d.name}»`, at: Date.now() }, { who: 'bot', text: resultText(done, { plain: true }), at: Date.now() }].slice(-30));
      return done;
    } catch (e) {
      log(`Документ «${d.name}»: ${e.message}`);
      update('documents', id, { status: 'error', error: String(e.message || e).slice(0, 500), done_at: Date.now() });
      return row(id);
    }
  })().finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

/**
 * Принять документ от владельца. → { id, duplicate?, done: Promise<строка документа> }
 * Ошибки, понятные владельцу (формат, размер), — исключением сразу.
 */
export function addDocument({ name, buf, via = 'panel', note = '' }) {
  name = path.basename(String(name || 'документ')).slice(0, 150);
  const problem = docProblem(name);
  if (problem) throw new Error(problem);
  if (!buf?.length) throw new Error('Файл пустой.');
  if (buf.length > MAX_DOC_BYTES) throw new Error('Файл больше 50 МБ. Пришлите нужную часть или сохраните его поменьше.');
  if (looksLikeChat(name, buf)) throw new Error('Это экспорт чата WhatsApp — его загружайте в «Обучение → Как вы пишете клиентам» (в Telegram — просто пришлите файл, я пойму сам).');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const same = get("SELECT id, created_at FROM documents WHERE sha = ? AND status != 'error'", sha);
  if (same && !note) return { id: same.id, duplicate: true, done: Promise.resolve(row(same.id)) };
  run("DELETE FROM documents WHERE sha = ? AND status = 'error'", sha);
  fs.mkdirSync(paths.docs, { recursive: true });
  const id = insert('documents', { name, size: buf.length, sha, via, note: String(note || '').slice(0, 1000), status: 'reading', created_at: Date.now() });
  const file = path.join(paths.docs, `${id}-${crypto.randomBytes(3).toString('hex')}.${ext(name) || 'bin'}`);
  fs.writeFileSync(file, buf);
  update('documents', id, { file });
  return { id, done: processDocument(id) };
}

export function listDocuments() {
  return all('SELECT id, name, size, via, status, title, summary, knowledge_file, result, error, created_at, done_at FROM documents ORDER BY id DESC')
    .map((d) => ({ ...d, result: JSON.parse(d.result || '{}'), running: running.has(d.id) }));
}

/** Удалить документ и его справку в знаниях. Отели, добавленные из него, остаются. */
export function deleteDocument(id) {
  const d = get('SELECT * FROM documents WHERE id = ?', id);
  if (!d) return;
  if (d.knowledge_file) deleteKnowledge(d.knowledge_file);
  if (d.file) fs.rmSync(d.file, { force: true });
  run('DELETE FROM documents WHERE id = ?', id);
}

/** После перезапуска: документы, которые не успели разобрать, — разбираем заново. */
export function resumeDocuments() {
  for (const d of all("SELECT id FROM documents WHERE status = 'reading'")) processDocument(d.id).catch(() => {});
}

/** Итог для владельца (Telegram, чат-учитель). */
export function resultText(d, { plain = false } = {}) {
  if (!d) return 'Документ не найден.';
  if (d.status === 'error') return `⚠️ «${d.name}»: ${d.error}`;
  if (d.status === 'replaced') return `📄 «${d.title || d.name}» заменён новым документом «${d.result?.replacedBy?.name || ''}».`;
  if (d.status !== 'done') return `📄 «${d.name}» — ещё читаю…`;
  const r = d.result || {};
  const lines = [`📄 ${d.title || d.name}`];
  if (d.summary) lines.push(d.summary);
  if (r.hotelsAdded?.length) lines.push(`Добавил отели: ${r.hotelsAdded.join(', ')}.`);
  if (r.hotelsUpdated?.length) lines.push(`Обновил отели: ${r.hotelsUpdated.join(', ')}.`);
  if (d.knowledge_file) lines.push(`Остальное записал в знания: «${d.knowledge_file.replace(/\.md$/, '')}».`);
  if (r.replaced?.length) lines.push(`Это новая версия: ${r.replaced.map((x) => `«${x.title || x.name}» (${x.name})`).join(', ')} — старую справку оттуда убрал.`);
  if (!r.hotelsAdded?.length && !r.hotelsUpdated?.length && !d.knowledge_file) lines.push('Полезного для клиентов в нём не нашёл.');
  if (r.truncated) lines.push(`Документ очень большой — прочитал только начало (около ${Math.round(MAX_CHARS / 1000)} тыс. знаков).`);
  if (r.questions?.length) {
    lines.push('', 'Уточните, пожалуйста:', ...r.questions.map((q) => `❓ ${q}`));
    if (!plain) lines.push('Ответьте мне сообщением — запомню.');
  }
  return lines.join('\n');
}
