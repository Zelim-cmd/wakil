// Знания бота: текстовые файлы (о компании, оплата, частые вопросы…) + карточки отелей с ценами.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, paths } from './config.mjs';
import { all, get, insert, update } from './db.mjs';

const TEMPLATE = path.join(ROOT, 'knowledge-template');

/** При первом запуске кладём образцы файлов знаний, чтобы было что заполнять. */
export function ensureKnowledge() {
  fs.mkdirSync(paths.knowledge, { recursive: true });
  if (fs.readdirSync(paths.knowledge).some((f) => f.endsWith('.md'))) return;
  for (const f of fs.readdirSync(TEMPLATE)) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(TEMPLATE, f), path.join(paths.knowledge, f));
  }
}

const safeName = (name) => {
  const base = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 80);
  if (!base) throw new Error('Пустое имя файла');
  return base.endsWith('.md') ? base : base + '.md';
};

export function listKnowledge() {
  ensureKnowledge();
  return fs.readdirSync(paths.knowledge).filter((f) => f.endsWith('.md')).sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(paths.knowledge, name), 'utf8');
      return { name, text, size: text.length };
    });
}
export function saveKnowledge(name, text) {
  ensureKnowledge();
  fs.writeFileSync(path.join(paths.knowledge, safeName(name)), String(text ?? ''));
}
export function deleteKnowledge(name) {
  fs.rmSync(path.join(paths.knowledge, safeName(name)), { force: true });
}

// ---------- отели ----------
export const CITY_LABEL = { makkah: 'Мекка', madinah: 'Медина', other: 'Другое' };

export function normCity(c) {
  const s = String(c || '').toLowerCase();
  if (/мекк|makk|mecc|makkah|مكة/.test(s)) return 'makkah';
  if (/медин|madin|medin|المدينة/.test(s)) return 'madinah';
  return s ? 'other' : '';
}

export function listHotels({ activeOnly = false } = {}) {
  return all(`SELECT * FROM hotels ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY city, name`);
}

const HOTEL_FIELDS = ['name', 'city', 'stars', 'distance', 'area', 'description', 'prices', 'prices_until', 'private_note', 'active'];
export function saveHotel(h) {
  const row = {};
  for (const k of HOTEL_FIELDS) if (h[k] !== undefined) row[k] = h[k];
  if (row.city !== undefined) row.city = normCity(row.city) || row.city;
  if (row.stars !== undefined) row.stars = row.stars === '' || row.stars == null ? null : Number(row.stars) || null;
  if (row.active !== undefined) row.active = row.active ? 1 : 0;
  row.updated_at = Date.now();
  if (h.id) { update('hotels', Number(h.id), row); return Number(h.id); }
  if (!row.name) throw new Error('У отеля нет названия');
  return insert('hotels', row);
}

/** Отель в ответе ИИ (чат-учитель, документы). Поля, которые не меняются, — null. */
export const HOTEL_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' }, city: { type: ['string', 'null'], description: 'makkah | madinah' }, stars: { type: ['integer', 'null'] },
    distance: { type: ['string', 'null'] }, area: { type: ['string', 'null'] }, description: { type: ['string', 'null'] },
    prices: { type: ['string', 'null'], description: 'Цены текстом, как в прайсе' }, prices_until: { type: ['string', 'null'], description: 'ГГГГ-ММ-ДД' },
    private_note: { type: ['string', 'null'], description: 'Только для владельца: комиссия, контакты отеля' },
    active: { type: ['boolean', 'null'] },
  },
  required: ['name', 'city', 'stars', 'distance', 'area', 'description', 'prices', 'prices_until', 'private_note', 'active'],
};

/** Добавить или обновить отели из ответа ИИ: знакомые — дополняем (null не трогает поле), новые — добавляем. */
export function mergeHotels(list) {
  const out = [];
  for (const h of list || []) {
    if (!h?.name) continue;
    const ex = findHotel(h.name);
    const patch = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null && v !== undefined));
    if (patch.prices_until && !/^\d{4}-\d{2}-\d{2}$/.test(patch.prices_until)) delete patch.prices_until;
    saveHotel(ex ? { ...patch, id: ex.id, name: ex.name } : patch);
    out.push({ name: ex ? ex.name : h.name, isNew: !ex });
  }
  return out;
}

/** Название отеля для сравнения: без регистра, значков над буквами (ô → o), слов «отель/hotel» и знаков. */
export function hotelKey(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(hotel|hotels|отель|гостиница)\b|فندق/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Найти отель по названию — для обучения и аналитики. */
export function findHotel(name) {
  const n = hotelKey(name);
  if (!n) return null;
  const hotels = listHotels();
  return hotels.find((h) => hotelKey(h.name) === n)
    || hotels.find((h) => { const k = hotelKey(h.name); return k.length >= 4 && n.length >= 4 && (k.includes(n) || n.includes(k)); })
    || null;
}

/** Каноническое имя отеля для аналитики: если такой есть в карточках — его название. */
export function canonicalHotel(name) {
  const h = findHotel(name);
  return h ? h.name : String(name || '').trim();
}

function today() { return new Date().toISOString().slice(0, 10); }

/** Текст отелей для ИИ: свежие цены — как есть, устаревшие — с пометкой «не называть». */
export function hotelsText({ pricing = 'list' } = {}) {
  const hotels = listHotels({ activeOnly: true });
  if (!hotels.length) return 'Карточек отелей пока нет. Ни один отель и ни одну цену не называй как точные — собери пожелания клиента и передай менеджеру.';
  const t = today();
  return hotels.map((h) => {
    const lines = [`### ${h.name} — ${CITY_LABEL[h.city] || h.city || 'город не указан'}${h.stars ? `, ${h.stars}★` : ''}`];
    if (h.distance) lines.push(`До Харама: ${h.distance}`);
    if (h.area) lines.push(`Район: ${h.area}`);
    if (h.description) lines.push(h.description.trim());
    if (pricing === 'owner') lines.push('Цены: называет только менеджер.');
    else if (!h.prices) lines.push('Цены: нет в прайсе — уточнит менеджер.');
    else if (h.prices_until && h.prices_until < t) lines.push(`Цены устарели (были актуальны до ${h.prices_until}) — НЕ называй их, скажи, что менеджер уточнит актуальную цену.`);
    else lines.push(`Цены${h.prices_until ? ` (актуальны до ${h.prices_until})` : ''}:\n${h.prices.trim()}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function knowledgeText() {
  return listKnowledge().map((f) => `## ${f.name.replace(/\.md$/, '').replace(/^\d+[-_. ]*/, '')}\n${f.text.trim()}`).join('\n\n');
}

export function hotelCount() { return get('SELECT COUNT(*) n FROM hotels WHERE active = 1').n; }
