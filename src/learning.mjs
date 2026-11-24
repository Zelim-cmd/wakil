// Обучение бота.
//  1) Уроки — короткие правила от владельца («в Рамадан минимум 5 ночей»). Бот видит их в каждом ответе.
//  2) Исправления — владелец в панели пишет, как надо было ответить. Бот учится на этих примерах.
//  3) Вопросы без ответа — бот сам собирает, владелец отвечает один раз, и бот запоминает.
//  4) Учитель — чат с ботом в панели или со своего личного WhatsApp: «запомни…», «вот новый прайс…».
//  5) Ежедневный разбор — бот сам перечитывает переписку за день, находит ошибки и предлагает уроки.
//     Владелец одобряет (или включает «одобрять самому»).
import { config } from './config.mjs';
import { get, all, run, insert, update, addEvent, kvGet, kvSet } from './db.mjs';
import { ask } from './ai/providers.mjs';
import { listHotels, findHotel, saveHotel, listKnowledge, CITY_LABEL } from './knowledge.mjs';
import { contactLabel, CHANNEL_LABEL } from './store.mjs';
import { notifyOwner } from './notify.mjs';
import { summaryText } from './analytics.mjs';

export function addLesson({ kind = 'rule', text, why = '', source = 'owner', status = 'active', contactId = null }) {
  const t = String(text || '').trim();
  if (!t) return null;
  const dup = get("SELECT id FROM lessons WHERE text = ? AND status != 'rejected'", t);
  if (dup) return dup.id;
  return insert('lessons', { kind, text: t.slice(0, 2000), why: String(why || '').slice(0, 500), source, status, created_at: Date.now(), contact_id: contactId });
}

export function lessonsForPrompt() {
  const active = all("SELECT * FROM lessons WHERE status = 'active' ORDER BY id");
  const rules = active.filter((l) => l.kind !== 'example').map((l) => `• ${l.text}`).join('\n');
  const examples = active.filter((l) => l.kind === 'example').slice(-15).map((l) => l.text).join('\n---\n');
  return { rules, examples };
}

// ---------- исправление ответа бота ----------
export async function correctMessage(messageId, better, why = '') {
  const m = get('SELECT * FROM messages WHERE id = ?', messageId);
  if (!m || m.author !== 'bot') throw new Error('Исправлять можно только ответы бота');
  update('messages', m.id, { corrected: String(better || '') });
  const before = all("SELECT * FROM messages WHERE contact_id = ? AND id < ? ORDER BY id DESC LIMIT 4", m.contact_id, m.id).reverse();
  const ctx = before.map((x) => `${x.author === 'client' ? 'Клиент' : x.author === 'owner' ? 'Менеджер' : 'Бот'}: ${x.text}`).join('\n');
  const example = `${ctx}\nБот ответил: ${m.text}\nНАДО БЫЛО: ${better}${why ? `\nПочему: ${why}` : ''}`;
  const id = addLesson({ kind: 'example', text: example, why, source: 'correction', contactId: m.contact_id });
  // и общее правило из этого исправления — чтобы работало и в похожих случаях
  const r = await ask({
    purpose: 'generalize',
    system: 'Ты помогаешь обучать ИИ-консультанта по отелям Мекки и Медины. Владелец исправил ответ бота. Сформулируй ОДНО короткое общее правило (1–2 предложения, по-русски, в повелительном наклонении), чтобы бот в похожих случаях отвечал как надо. Не привязывай правило к конкретному клиенту.',
    prompt: example,
    schema: { type: 'object', properties: { rule: { type: 'string' } }, required: ['rule'] },
  });
  if (r.ok && r.data?.rule) addLesson({ kind: 'rule', text: r.data.rule, why: 'из исправления ответа', source: 'correction', contactId: m.contact_id });
  return id;
}

// ---------- вопросы, на которые бот не знал ответа ----------
export function answerQuestion(id, answer) {
  const q = get('SELECT * FROM questions WHERE id = ?', id);
  if (!q) throw new Error('Нет такого вопроса');
  update('questions', id, { status: 'answered', answer: String(answer || '') });
  addLesson({ kind: 'faq', text: `Вопрос: ${q.text}\nОтвет: ${answer}`, source: 'owner', contactId: q.contact_id });
}

// ---------- учитель: свободный разговор владельца с ботом ----------
const TEACH_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Ответ владельцу, по-русски, коротко' },
    lessons: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['rule', 'faq'] }, text: { type: 'string' } }, required: ['kind', 'text'] } },
    hotels: {
      type: 'array',
      description: 'Отели, которые нужно добавить или изменить. Поля, которые не меняются, — null.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, city: { type: ['string', 'null'], description: 'makkah | madinah' }, stars: { type: ['integer', 'null'] },
          distance: { type: ['string', 'null'] }, area: { type: ['string', 'null'] }, description: { type: ['string', 'null'] },
          prices: { type: ['string', 'null'], description: 'Цены текстом, как в прайсе' }, prices_until: { type: ['string', 'null'], description: 'ГГГГ-ММ-ДД' },
          private_note: { type: ['string', 'null'], description: 'Только для владельца: комиссия, контакты отеля' },
          active: { type: ['boolean', 'null'] },
        },
        required: ['name', 'city', 'stars', 'distance', 'area', 'description', 'prices', 'prices_until', 'private_note', 'active'],
      },
    },
    answers: { type: 'array', items: { type: 'object', properties: { question_id: { type: 'integer' }, answer: { type: 'string' } }, required: ['question_id', 'answer'] } },
    retire_lessons: { type: 'array', items: { type: 'integer' }, description: 'Номера уроков, которые владелец просит отменить' },
  },
  required: ['reply', 'lessons', 'hotels', 'answers', 'retire_lessons'],
};

export async function ownerChat(text, { via = 'panel' } = {}) {
  const history = kvGet('teach_history', []);
  const lessons = all("SELECT id, kind, text FROM lessons WHERE status = 'active' AND kind != 'example' ORDER BY id");
  const questions = all("SELECT id, text FROM questions WHERE status = 'open' ORDER BY id DESC LIMIT 30");
  const hotels = listHotels().map((h) => `${h.name} (${CITY_LABEL[h.city] || h.city}${h.stars ? `, ${h.stars}★` : ''}${h.active ? '' : ', скрыт'}): цены ${h.prices ? `до ${h.prices_until || '?'}` : 'нет'}`).join('\n');
  const system = `Ты — ${config().business.agentName || 'Вакиль'}, ИИ-консультант по отелям Мекки и Медины. Сейчас с тобой говорит ВЛАДЕЛЕЦ бизнеса (не клиент): он тебя обучает и спрашивает о делах.
Что ты умеешь здесь:
- Запомнить правило или ответ на частый вопрос → lessons (коротко, ясно, в повелительном наклонении: «Называй цены в риялах»).
- Добавить или изменить отель и цены → hotels. Если владелец прислал прайс текстом — разбери его по отелям; prices пиши понятным текстом (тип номера — цена — за что), prices_until — до какой даты цены верны (если не сказано — спроси в reply и оставь null).
- Ответить на вопросы клиентов, которые ты не знал → answers (question_id из списка ниже).
- Отменить урок → retire_lessons.
- Ответить на вопрос о делах по сводке ниже.
В lessons, hotels и answers записывай ТОЛЬКО то, что владелец сказал прямо, — без своих выводов и догадок (даты праздников, курсы, условия). Закрывай вопрос клиента (answers), только если владелец действительно на него ответил. Если чего-то не хватает — спроси в reply. Если владелец просит что-то, чего ты не умеешь (например, написать клиенту), скажи, где это сделать в панели. Ответ — по-русски, коротко.${via === 'whatsapp' ? ' Это переписка в WhatsApp: без форматирования, коротко.' : ''}

ТЕКУЩИЕ УРОКИ (номер: текст):
${lessons.map((l) => `${l.id}: ${l.text}`).join('\n') || '(нет)'}

ОТЕЛИ:
${hotels || '(нет)'}

ВОПРОСЫ КЛИЕНТОВ БЕЗ ОТВЕТА (номер: вопрос):
${questions.map((q) => `${q.id}: ${q.text}`).join('\n') || '(нет)'}

ФАЙЛЫ ЗНАНИЙ: ${listKnowledge().map((f) => f.name).join(', ')}

СВОДКА ЗА 30 ДНЕЙ:
${summaryText(30)}`;
  const prompt = [...history.slice(-8).map((h) => `${h.who === 'owner' ? 'Владелец' : 'Ты'}: ${h.text}`), `Владелец: ${text}`].join('\n\n');
  const r = await ask({ purpose: 'teach', system, prompt, schema: TEACH_SCHEMA, smart: true });
  if (!r.ok) return { ok: false, reply: `Не получилось: ${r.message}` };
  const d = r.data || {};
  const done = [];
  for (const l of d.lessons || []) if (addLesson({ kind: l.kind === 'faq' ? 'faq' : 'rule', text: l.text, source: 'teach' })) done.push(`запомнил: «${l.text}»`);
  for (const h of d.hotels || []) {
    if (!h?.name) continue;
    const ex = findHotel(h.name);
    const patch = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null && v !== undefined));
    saveHotel(ex ? { ...patch, id: ex.id, name: ex.name } : patch);
    done.push(`${ex ? 'обновил' : 'добавил'} отель ${ex ? ex.name : h.name}`);
  }
  for (const a of d.answers || []) {
    try { answerQuestion(a.question_id, a.answer); done.push(`ответ на вопрос №${a.question_id}`); } catch {}
  }
  for (const id of d.retire_lessons || []) { run("UPDATE lessons SET status = 'rejected' WHERE id = ?", id); done.push(`отменил урок №${id}`); }
  const reply = String(d.reply || 'Готово.').trim();
  kvSet('teach_history', [...history, { who: 'owner', text, at: Date.now() }, { who: 'bot', text: reply, at: Date.now() }].slice(-30));
  if (done.length) addEvent('teach', null, { done });
  return { ok: true, reply, done };
}

// ---------- ежедневный разбор ----------
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    report: { type: 'string', description: 'Отчёт владельцу по-русски: что было за день, где бот ошибся или упустил клиента, что улучшить. 5–12 строк.' },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['rule', 'faq'] },
          text: { type: 'string', description: 'Урок для бота — коротко, в повелительном наклонении' },
          why: { type: 'string', description: 'Что в переписке к этому привело' },
        },
        required: ['kind', 'text', 'why'],
      },
    },
  },
  required: ['report', 'proposals'],
};

export async function dailyReview({ hours = 24, force = false } = {}) {
  const since = Date.now() - hours * 3600000;
  const contacts = all("SELECT * FROM contacts WHERE last_at > ? AND channel != 'test' ORDER BY last_at DESC LIMIT 60", since);
  if (!contacts.length && !force) return { ok: true, skipped: true, report: 'За день переписки не было.' };
  let budget = 70000;
  const blocks = [];
  for (const c of contacts) {
    const msgs = all('SELECT * FROM messages WHERE contact_id = ? AND at > ? ORDER BY at, id', c.id, since - 6 * 3600000).slice(-30);
    if (!msgs.length) continue;
    const t = `### Клиент #${c.id} ${contactLabel(c)} (${CHANNEL_LABEL[c.channel]}), стадия: ${c.stage}${c.lost_reason ? `, отказ: ${c.lost_reason}` : ''}\n` +
      msgs.map((m) => `${m.author === 'client' ? 'Клиент' : m.author === 'bot' ? 'Бот' : m.author === 'owner' ? 'МЕНЕДЖЕР' : 'Система'}: ${m.media_kind ? `[${m.media_kind}] ` : ''}${m.text}${m.corrected ? `\n  (владелец исправил на: ${m.corrected})` : ''}`).join('\n');
    if (t.length > budget) break;
    budget -= t.length;
    blocks.push(t);
  }
  const lessons = all("SELECT text FROM lessons WHERE status IN ('active','proposed') AND kind != 'example'").map((l) => '• ' + l.text).join('\n');
  const questions = all("SELECT text FROM questions WHERE status = 'open' AND at > ?", since).map((q) => '• ' + q.text).join('\n');
  const r = await ask({
    purpose: 'review', smart: true, schema: REVIEW_SCHEMA, timeoutMs: 420000,
    system: `Ты — наставник ИИ-консультанта, который продаёт клиентам размещение в отелях Мекки и Медины. Разбери переписку за день и помоги боту стать лучше.
Ищи: где бот ответил неверно, выдумал, не ответил на вопрос, был слишком длинным или сухим, задал лишние вопросы, упустил клиента, не позвал менеджера вовремя. Особенно ценны места, где вмешался МЕНЕДЖЕР: как он ответил — так и надо было; и исправления владельца.
Предложи до 8 уроков — только полезные и новые (не повторяй уже существующие). Урок — общее правило, без имён клиентов. Не предлагай уроки с ценами и фактами, которых нет в переписке менеджера.

УЖЕ ЕСТЬ УРОКИ:
${lessons || '(нет)'}`,
    prompt: `ВОПРОСЫ, НА КОТОРЫЕ БОТ НЕ ЗНАЛ ОТВЕТА:\n${questions || '(нет)'}\n\nПЕРЕПИСКА ЗА ${hours} Ч:\n\n${blocks.join('\n\n') || '(нет)'}`,
  });
  if (!r.ok) return { ok: false, message: r.message };
  const auto = !!config().behavior.autoApproveLessons;
  const ids = [];
  for (const p of r.data.proposals || []) {
    const id = addLesson({ kind: p.kind === 'faq' ? 'faq' : 'rule', text: p.text, why: p.why, source: 'review', status: auto ? 'active' : 'proposed' });
    if (id) ids.push(id);
  }
  kvSet('last_review', { at: Date.now(), report: r.data.report, proposals: ids.length });
  addEvent('review', null, { report: r.data.report, proposals: ids.length });
  const tail = ids.length ? (auto ? `\nДобавил уроков: ${ids.length}.` : `\nПредлагаю уроков: ${ids.length} — одобрите в панели, раздел «Обучение».`) : '';
  notifyOwner('review', `📋 Разбор дня\n${r.data.report}${tail}`);
  return { ok: true, report: r.data.report, proposals: ids.length };
}

export function setLessonStatus(id, status) {
  if (!['active', 'proposed', 'rejected'].includes(status)) throw new Error('Неверный статус');
  run('UPDATE lessons SET status = ? WHERE id = ?', status, id);
}
export function editLesson(id, text) { run('UPDATE lessons SET text = ? WHERE id = ?', String(text || '').trim(), id); }
export function deleteLesson(id) { run('DELETE FROM lessons WHERE id = ?', id); }

export function teachHistory() { return kvGet('teach_history', []); }
export function clearTeachHistory() { kvSet('teach_history', []); }

