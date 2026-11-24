// Аналитика: воронка, интерес к отелям, брони, оплаты, долги, сезонность, источники, работа бота.
import { config } from './config.mjs';
import { get, all } from './db.mjs';
import { ask } from './ai/providers.mjs';
import { STAGES, STAGE_LABEL, CHANNEL_LABEL } from './store.mjs';
import { CITY_LABEL } from './knowledge.mjs';

const DAY = 86400000;
const NOT_TEST = "channel != 'test' AND imported = 0";

function tzParts(ms) {
  const tz = config().business.timezone || 'Asia/Riyadh';
  let f;
  try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  catch { f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

const sumBy = (rows, key, val) => {
  const out = {};
  for (const r of rows) { const k = r[key] || '—'; out[k] = (out[k] || 0) + (Number(r[val]) || 0); }
  return out;
};
const round = (n, d = 0) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
function median(arr) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function top(map, n = 10) { return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, value: v })); }

/** Всё для страницы «Аналитика». days = 0 — за всё время. */
export function stats(days = 30) {
  const now = Date.now();
  const since = days > 0 ? now - days * DAY : 0;
  const contacts = all(`SELECT * FROM contacts WHERE ${NOT_TEST} AND created_at >= ?`, since);
  const ids = new Set(contacts.map((c) => c.id));
  const realIds = all(`SELECT id FROM contacts WHERE ${NOT_TEST}`).map((r) => r.id);
  const realSet = new Set(realIds);

  // сообщения
  const msgs = all('SELECT contact_id, dir, author, at FROM messages WHERE at >= ?', since).filter((m) => realSet.has(m.contact_id));
  const msgIn = msgs.filter((m) => m.dir === 'in');
  const byBot = msgs.filter((m) => m.author === 'bot').length;
  const byOwner = msgs.filter((m) => m.author === 'owner').length;

  // скорость первого ответа (по новым клиентам)
  const firstIn = {}, firstOut = {};
  for (const m of all('SELECT contact_id, dir, author, at FROM messages WHERE at >= ? ORDER BY at', since)) {
    if (!ids.has(m.contact_id)) continue;
    if (m.dir === 'in' && firstIn[m.contact_id] == null) firstIn[m.contact_id] = m.at;
    if (m.dir === 'out' && firstIn[m.contact_id] != null && firstOut[m.contact_id] == null) firstOut[m.contact_id] = m.at;
  }
  const respTimes = Object.keys(firstOut).map((k) => (firstOut[k] - firstIn[k]) / 1000);

  // брони и оплаты
  const bookings = all("SELECT b.*, c.channel FROM bookings b LEFT JOIN contacts c ON c.id = b.contact_id WHERE b.created_at >= ? AND b.status != 'cancelled'", since)
    .filter((b) => b.channel !== 'test');
  const cancelled = get("SELECT COUNT(*) n FROM bookings WHERE created_at >= ? AND status = 'cancelled'", since).n;
  const payConfirmed = all("SELECT * FROM payments WHERE at >= ? AND status = 'confirmed'", since);
  const payClaimed = all("SELECT p.* FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.status = 'claimed' AND (c.channel IS NULL OR c.channel != 'test')");
  // долги: по всем живым броням (за всё время) — сумма брони минус подтверждённые оплаты
  const debts = {};
  for (const b of all("SELECT * FROM bookings WHERE status IN ('pending','confirmed','completed')")) {
    const paid = get("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE booking_id = ? AND status = 'confirmed'", b.id).s;
    const left = (Number(b.total) || 0) - paid;
    if (left > 0.5) debts[b.currency || '—'] = (debts[b.currency || '—'] || 0) + left;
  }
  const bookedContacts = new Set(bookings.map((b) => b.contact_id).filter((id) => ids.has(id)));

  // воронка: до какой стадии дошёл каждый новый клиент
  const order = STAGES.filter((s) => s !== 'lost');
  const reached = Object.fromEntries(order.map((s) => [s, 0]));
  let lost = 0;
  const logs = all('SELECT contact_id, stage FROM stage_log WHERE at >= ?', since);
  const maxIdx = {};
  const lostSet = new Set();
  for (const l of logs) {
    if (!ids.has(l.contact_id)) continue;
    if (l.stage === 'lost') { lostSet.add(l.contact_id); continue; }
    const i = order.indexOf(l.stage);
    if (i > (maxIdx[l.contact_id] ?? -1)) maxIdx[l.contact_id] = i;
  }
  for (const c of contacts) {
    const i = Math.max(maxIdx[c.id] ?? 0, order.indexOf(c.stage));
    for (let k = 0; k <= i && k < order.length; k++) reached[order[k]]++;
  }
  lost = lostSet.size;
  const funnel = [
    ...order.map((s) => ({ key: s, label: STAGE_LABEL[s], value: reached[s] })),
    { key: 'booked', label: 'Есть бронь', value: bookedContacts.size },
  ];

  // каналы
  const channels = {};
  for (const c of contacts) { const k = CHANNEL_LABEL[c.channel] || c.channel; (channels[k] ||= { contacts: 0, bookings: 0 }).contacts++; }
  for (const b of bookings) { const k = CHANNEL_LABEL[b.channel] || b.channel || '—'; (channels[k] ||= { contacts: 0, bookings: 0 }).bookings++; }

  // отели: интерес и брони
  const interest = {};
  for (const r of all('SELECT hotel, COUNT(DISTINCT contact_id) n FROM interests WHERE at >= ? AND contact_id IN (SELECT id FROM contacts WHERE channel != \'test\' AND imported = 0) GROUP BY hotel', since)) interest[r.hotel] = r.n;
  const hotelBook = {}, hotelRev = {};
  for (const b of bookings) { const h = b.hotel || '—'; hotelBook[h] = (hotelBook[h] || 0) + 1; hotelRev[h] = (hotelRev[h] || 0) + (Number(b.total) || 0); }
  const hotelNames = [...new Set([...Object.keys(interest), ...Object.keys(hotelBook)])];
  const hotels = hotelNames.map((h) => ({ hotel: h, interest: interest[h] || 0, bookings: hotelBook[h] || 0, revenue: round(hotelRev[h] || 0) }))
    .sort((a, b) => b.bookings - a.bookings || b.interest - a.interest).slice(0, 20);

  // заявки: город, месяцы поездок, группы, бюджеты
  const reqs = all("SELECT r.* FROM requests r JOIN contacts c ON c.id = r.contact_id WHERE c.channel != 'test' AND c.imported = 0 AND r.updated_at >= ?", since);
  const cities = {}; for (const r of reqs) if (r.city) { const k = r.city === 'both' ? 'Мекка и Медина' : CITY_LABEL[r.city] || r.city; cities[k] = (cities[k] || 0) + 1; }
  const months = {}; for (const r of reqs) if (r.check_in) { const k = r.check_in.slice(0, 7); months[k] = (months[k] || 0) + 1; }
  const tripTypes = {}; for (const r of reqs) if (r.trip_type) { const k = { umrah: 'Умра', hajj: 'Хадж', other: 'Другое' }[r.trip_type] || r.trip_type; tripTypes[k] = (tripTypes[k] || 0) + 1; }
  const roomTypes = {}; for (const r of reqs) if (r.room_type) { const k = r.room_type.toLowerCase(); roomTypes[k] = (roomTypes[k] || 0) + 1; }
  const meals = {}; for (const r of reqs) if (r.meals) { const k = r.meals.toLowerCase(); meals[k] = (meals[k] || 0) + 1; }
  const curCount = {}; for (const r of reqs) if (r.budget && r.currency) curCount[r.currency] = (curCount[r.currency] || 0) + 1;
  const mainCur = top(curCount, 1)[0]?.key || null;

  // отказы
  const lostReasons = {};
  for (const c of all(`SELECT lost_reason FROM contacts WHERE ${NOT_TEST} AND stage = 'lost' AND last_at >= ?`, since)) {
    const k = (c.lost_reason || 'причина не известна').toLowerCase().slice(0, 80);
    lostReasons[k] = (lostReasons[k] || 0) + 1;
  }

  // по дням и по часам
  const timeline = {};
  const dayKey = (ms) => tzParts(ms).day;
  const span = days > 0 ? days : Math.min(365, Math.ceil((now - (get(`SELECT MIN(created_at) m FROM contacts WHERE ${NOT_TEST}`).m || now)) / DAY) + 1);
  for (let i = span - 1; i >= 0; i--) timeline[dayKey(now - i * DAY)] = { contacts: 0, messages: 0, bookings: 0 };
  for (const c of contacts) { const k = dayKey(c.created_at); if (timeline[k]) timeline[k].contacts++; }
  for (const m of msgIn) { const k = dayKey(m.at); if (timeline[k]) timeline[k].messages++; }
  for (const b of bookings) { const k = dayKey(b.created_at); if (timeline[k]) timeline[k].bookings++; }
  const hours = Array(24).fill(0);
  for (const m of msgIn) hours[tzParts(m.at).hour]++;

  // работа ИИ
  const aiRows = all('SELECT purpose, ok, ms, error FROM ai_calls WHERE at >= ?', since);
  const ai = {
    calls: aiRows.length,
    errors: aiRows.filter((r) => !r.ok).length,
    limits: aiRows.filter((r) => !r.ok && /^limit/.test(r.error)).length,
    avgSec: round(aiRows.filter((r) => r.ok && r.purpose === 'reply').reduce((s, r, _, a) => s + r.ms / 1000 / a.length, 0), 1),
  };

  return {
    days, since,
    totals: {
      newContacts: contacts.length,
      activeChats: new Set(msgIn.map((m) => m.contact_id)).size,
      messagesIn: msgIn.length,
      byBot, byOwner,
      botShare: byBot + byOwner ? round((byBot / (byBot + byOwner)) * 100) : null,
      handoffs: get("SELECT COUNT(*) n FROM events WHERE type = 'handoff' AND at >= ?", since).n,
      firstResponseMedianSec: round(median(respTimes)),
      bookings: bookings.length,
      cancelled,
      conversion: contacts.length ? round((bookedContacts.size / contacts.length) * 100, 1) : null,
      lost,
      revenue: sumBy(bookings, 'currency', 'total'),
      commission: sumBy(bookings, 'currency', 'commission'),
      paid: sumBy(payConfirmed, 'currency', 'amount'),
      claimed: { count: payClaimed.length, sum: sumBy(payClaimed, 'currency', 'amount') },
      debts,
      avgGuests: round(reqs.filter((r) => r.guests).reduce((s, r, _, a) => s + r.guests / a.length, 0), 1) || null,
      avgNights: round(reqs.filter((r) => r.nights).reduce((s, r, _, a) => s + r.nights / a.length, 0), 1) || null,
      medianBudget: mainCur ? { value: round(median(reqs.filter((r) => r.currency === mainCur).map((r) => r.budget))), currency: mainCur } : null,
    },
    funnel, channels, hotels,
    cities: top(cities), months: Object.entries(months).sort().map(([key, value]) => ({ key, value })),
    tripTypes: top(tripTypes), roomTypes: top(roomTypes, 8), meals: top(meals, 8),
    lostReasons: top(lostReasons, 10),
    unanswered: all("SELECT q.id, q.text, q.at, q.contact_id FROM questions q WHERE q.status = 'open' ORDER BY q.id DESC LIMIT 30"),
    timeline: Object.entries(timeline).map(([day, v]) => ({ day, ...v })),
    hours, ai,
  };
}

const money = (obj) => Object.entries(obj || {}).filter(([, v]) => v).map(([k, v]) => `${Math.round(v).toLocaleString('ru-RU')} ${k}`).join(', ') || '0';

/** Короткая сводка текстом — для отчётов и для ИИ. */
export function summaryText(days = 7) {
  const s = stats(days);
  const t = s.totals;
  const lines = [
    `За ${days} дн.: новых клиентов ${t.newContacts}, активных чатов ${t.activeChats}, броней ${t.bookings}${t.conversion != null ? ` (конверсия ${t.conversion}%)` : ''}, отказов ${t.lost}.`,
    `Сумма броней: ${money(t.revenue)}; комиссия: ${money(t.commission)}; получено оплат: ${money(t.paid)}.`,
    `Ждут подтверждения оплаты: ${t.claimed.count}. Долги клиентов: ${money(t.debts)}.`,
    `Бот ответил ${t.byBot} раз, менеджер ${t.byOwner}; передано менеджеру: ${t.handoffs}.${t.firstResponseMedianSec != null ? ` Первый ответ в среднем через ${Math.round(t.firstResponseMedianSec)} с.` : ''}`,
  ];
  if (s.hotels.length) lines.push('Отели (интерес/брони): ' + s.hotels.slice(0, 6).map((h) => `${h.hotel} ${h.interest}/${h.bookings}`).join('; ') + '.');
  if (s.cities.length) lines.push('Города: ' + s.cities.map((c) => `${c.key} ${c.value}`).join(', ') + '.');
  if (s.months.length) lines.push('Месяцы заезда: ' + s.months.slice(-6).map((m) => `${m.key}: ${m.value}`).join(', ') + '.');
  if (s.lostReasons.length) lines.push('Причины отказов: ' + s.lostReasons.slice(0, 4).map((r) => `${r.key} (${r.value})`).join('; ') + '.');
  if (s.unanswered.length) lines.push(`Вопросов без ответа: ${s.unanswered.length}.`);
  if (s.ai.errors) lines.push(`Сбоев ИИ: ${s.ai.errors}${s.ai.limits ? `, из них лимит подписки: ${s.ai.limits}` : ''}.`);
  return lines.join('\n');
}

/** ИИ-аналитик: вопрос владельца о делах → ответ по цифрам. Имена и телефоны клиентов ИИ не получает. */
export async function analyst(question, days = 90) {
  const s = stats(days);
  const reqs = all(`SELECT r.status, r.city, r.hotels, r.check_in, r.nights, r.guests, r.rooms, r.room_type, r.meals, r.budget, r.currency, r.trip_type, c.channel, c.stage, c.lost_reason, c.created_at
    FROM requests r JOIN contacts c ON c.id = r.contact_id WHERE c.channel != 'test' AND r.updated_at >= ? ORDER BY r.id DESC LIMIT 300`, days ? Date.now() - days * DAY : 0);
  const bookings = all("SELECT hotel, city, check_in, nights, guests, rooms, room_type, total, currency, commission, status, created_at FROM bookings WHERE created_at >= ? ORDER BY id DESC LIMIT 300", days ? Date.now() - days * DAY : 0);
  const r = await ask({
    purpose: 'analyst', smart: true, timeoutMs: 300000,
    system: 'Ты — бизнес-аналитик агентства, которое бронирует отели в Мекке и Медине для паломников. Отвечай владельцу по-русски, по делу, с цифрами из данных. Не выдумывай чисел, которых нет. Если данных мало для вывода — так и скажи. В конце дай 1–3 практических совета. Без markdown-таблиц; можно короткие списки.',
    prompt: `ВОПРОС ВЛАДЕЛЬЦА: ${question}\n\nСТАТИСТИКА ЗА ${days || 'всё'} ДН. (JSON):\n${JSON.stringify({ ...s, timeline: undefined, unanswered: s.unanswered.map((q) => q.text) })}\n\nЗАЯВКИ (последние ${reqs.length}):\n${JSON.stringify(reqs)}\n\nБРОНИ (последние ${bookings.length}):\n${JSON.stringify(bookings)}`,
  });
  return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.message };
}

// ---------- выгрузка в Excel (CSV) ----------
const EXPORTS = {
  clients: `SELECT c.id AS "№", c.channel AS "Канал", c.name AS "Имя", c.phone AS "Телефон", c.username AS "Ник", c.lang AS "Язык",
      datetime(c.created_at/1000,'unixepoch') AS "Первое сообщение", datetime(c.last_at/1000,'unixepoch') AS "Последнее",
      c.stage AS "Стадия", c.lost_reason AS "Причина отказа", c.summary AS "Кратко", c.notes AS "Заметки"
    FROM contacts c WHERE c.channel != 'test' AND c.imported = 0 ORDER BY c.id`,
  requests: `SELECT r.id AS "№", r.contact_id AS "Клиент №", c.name AS "Имя", r.status AS "Статус", r.city AS "Город", r.hotels AS "Отели",
      r.check_in AS "Заезд", r.check_out AS "Выезд", r.nights AS "Ночей", r.guests AS "Гостей", r.rooms AS "Номеров", r.room_type AS "Тип номера",
      r.meals AS "Питание", r.budget AS "Бюджет", r.currency AS "Валюта", r.trip_type AS "Поездка", r.notes AS "Пожелания",
      datetime(r.created_at/1000,'unixepoch') AS "Создана"
    FROM requests r LEFT JOIN contacts c ON c.id = r.contact_id WHERE c.channel IS NULL OR c.channel != 'test' ORDER BY r.id`,
  bookings: `SELECT b.id AS "№", b.contact_id AS "Клиент №", c.name AS "Имя", b.hotel AS "Отель", b.city AS "Город", b.check_in AS "Заезд", b.check_out AS "Выезд",
      b.nights AS "Ночей", b.guests AS "Гостей", b.rooms AS "Номеров", b.room_type AS "Тип номера", b.total AS "Сумма", b.currency AS "Валюта",
      b.commission AS "Комиссия", b.status AS "Статус", datetime(b.created_at/1000,'unixepoch') AS "Создана", b.note AS "Заметка"
    FROM bookings b LEFT JOIN contacts c ON c.id = b.contact_id ORDER BY b.id`,
  payments: `SELECT p.id AS "№", p.booking_id AS "Бронь №", p.contact_id AS "Клиент №", c.name AS "Имя", p.amount AS "Сумма", p.currency AS "Валюта",
      p.method AS "Способ", p.status AS "Статус", datetime(p.at/1000,'unixepoch') AS "Когда", p.note AS "Заметка"
    FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id ORDER BY p.id`,
};
export const EXPORT_NAMES = Object.keys(EXPORTS);

export function exportCsv(name) {
  const sql = EXPORTS[name];
  if (!sql) throw new Error('Нет такой выгрузки');
  const rows = all(sql);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const cell = (v) => { const s = v == null ? '' : String(v); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // точка с запятой и BOM — чтобы Excel на русской Windows открыл без каракулей
  return '﻿' + [cols.map(cell).join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\r\n');
}
