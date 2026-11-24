// Панель Вакиля. Без сборки и библиотек: обычный JavaScript.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');

// ---------- связь с сервером ----------
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-wakil': '1' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  let j = null;
  try { j = await r.json(); } catch {}
  if (r.status === 401 && j?.login) { showLogin(); throw new Error('Нужен вход'); }
  if (!r.ok) throw new Error(j?.error || `Ошибка ${r.status}`);
  return j;
}
function showLogin() {
  document.body.dataset.login = '1';
  $('#login').classList.remove('hidden');
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/login', { password: $('#loginPw').value }); location.reload(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});

// ---------- мелочи ----------
let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 2600);
}
function modal(html, onMount) {
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  if (onMount) onMount($('#modalBody'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.hasAttribute('data-close')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

const pad = (n) => String(n).padStart(2, '0');
function fTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return t;
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? '.' + d.getFullYear() : ''} ${t}`;
}
function fDate(s) { if (!s) return ''; const [y, m, d] = String(s).split('-'); return d ? `${d}.${m}.${y}` : s; }
const fNum = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 }));
function fMoney(obj) {
  const e = Object.entries(obj || {}).filter(([, v]) => v);
  return e.length ? e.map(([k, v]) => `${Math.round(v).toLocaleString('ru-RU')} ${esc(k)}`).join('<br>') : '0';
}
function ago(ms) {
  if (!ms) return 'никогда';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return fTime(ms);
}
async function busy(btn, fn) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + old;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; btn.innerHTML = old; }
}
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k] ||= {}; a[ks[ks.length - 1]] = v; }

const CH = { waqr: '🟢 WhatsApp', wacloud: '🟢 WhatsApp', instagram: '🟣 Instagram', test: '🧪 Проверка', import: '📚 Архив' };
const STAGE = { new: 'Новый', consulting: 'Консультация', offer: 'Предложены варианты', deciding: 'Думает', booking: 'Оформление', paid: 'Оплатил', lost: 'Отказ' };
const STAGE_TAG = { new: 'blue', consulting: '', offer: 'gold', deciding: 'gold', booking: 'green', paid: 'green', lost: 'red' };
const CITY = { makkah: 'Мекка', madinah: 'Медина', both: 'Мекка и Медина', other: 'Другое' };
const BOOK_STATUS = { pending: 'Ожидает', confirmed: 'Подтверждена', completed: 'Завершена', cancelled: 'Отменена' };
const PAY_STATUS = { claimed: 'Клиент сообщил', confirmed: 'Подтверждена', rejected: 'Отклонена' };
const stageTag = (s) => `<span class="tag ${STAGE_TAG[s] || ''}">${esc(STAGE[s] || s)}</span>`;
const nameOf = (c) => c.name || (c.username ? '@' + c.username : '') || (c.phone ? '+' + c.phone : '') || `Клиент #${c.id}`;

/** Простая разметка из ответа ИИ: заголовки, **жирный**, списки. Всё остальное — как текст. */
function mdLite(t) {
  return String(t || '').split('\n').map((line) => {
    let h = esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (/^#{1,6}\s/.test(line)) return `<h3 style="margin:12px 0 4px">${h.replace(/^#{1,6}\s*/, '')}</h3>`;
    if (/^\s*[-*•]\s/.test(line)) return `<div style="padding-left:14px">• ${h.replace(/^\s*[-*•]\s*/, '')}</div>`;
    return h ? `<div>${h}</div>` : '<div style="height:8px"></div>';
  }).join('');
}

// ---------- формы из описания ----------
function fieldHtml(f, cfg) {
  const v = getPath(cfg, f.k);
  const hint = f.hint ? `<small class="muted">${f.hint}</small>` : '';
  if (f.type === 'check') return `<label class="check"><input type="checkbox" data-k="${f.k}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>${hint}`;
  let input;
  if (f.type === 'textarea') input = `<textarea data-k="${f.k}" rows="${f.rows || 3}" placeholder="${esc(f.ph || '')}">${esc(v)}</textarea>`;
  else if (f.type === 'select') input = `<select data-k="${f.k}">${f.options.map(([val, lbl]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lbl)}</option>`).join('')}</select>`;
  else input = `<input data-k="${f.k}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.ph || '')}" ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
  return `<label class="f"><span>${esc(f.label)}</span>${input}${hint}</label>`;
}
function collect(el) {
  const out = {};
  for (const i of $$('[data-k]', el)) {
    let v = i.type === 'checkbox' ? i.checked : i.value;
    if (i.type === 'number') v = v === '' ? 0 : Number(v);
    setPath(out, i.dataset.k, v);
  }
  return out;
}

// ---------- навигация ----------
let pageTimers = [];
const every = (ms, fn) => pageTimers.push(setInterval(fn, ms));
const PAGES = {};
async function route() {
  pageTimers.forEach(clearInterval); pageTimers = [];
  const [page, arg] = (location.hash.slice(1) || 'home').split('/');
  const name = page === 'chat' ? 'chats' : page;
  $$('.side a').forEach((a) => a.classList.toggle('active', a.dataset.page === name));
  const fn = PAGES[name] || PAGES.home;
  try { await fn(arg); } catch (e) { main.innerHTML = `<div class="card err">Ошибка: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

let OV = null;
async function refreshOverview() {
  try { OV = await api('/api/overview'); } catch { return; }
  $('#brandName').textContent = OV.business || 'Вакиль';
  $('#brandSub').textContent = OV.business ? `ИИ-консультант «${OV.agentName}»` : 'ИИ-консультант';
  $('#b-chats').textContent = OV.counts.attention || '';
  $('#b-bookings').textContent = OV.counts.claimed || '';
  $('#b-learn').textContent = (OV.counts.proposals + OV.counts.questions) || '';
  $('#botSwitch').checked = OV.botEnabled;
  $('#botSwitchText').textContent = OV.botEnabled ? 'Бот включён' : 'Бот выключен';
}
$('#botSwitch').addEventListener('change', async (e) => {
  await api('/api/settings', { behavior: { botEnabled: e.target.checked } });
  toast(e.target.checked ? 'Бот снова отвечает клиентам' : 'Бот выключен — клиентам отвечаете вы');
  refreshOverview();
});

// ======================= СВОДКА =======================
PAGES.home = async () => {
  await refreshOverview();
  const [att, st] = await Promise.all([api('/api/contacts?filter=attention'), api('/api/stats?days=7')]);
  const o = OV, ch = o.channels;
  const wa = ch.waqr?.state === 'connected' || ch.wacloud?.state === 'connected';
  const steps = [
    [o.aiLast?.ok, 'Подключите ИИ — Claude или ChatGPT по подписке', '#connect'],
    [o.knowledgeFilled, 'Расскажите боту о компании, оплате и частых вопросах', '#knowledge'],
    [o.counts.hotels > 0, 'Добавьте отели и цены (можно просто вставить прайс в «Обучение»)', '#knowledge'],
    [o.tested, 'Поговорите с ботом как клиент и поправьте ответы', '#test'],
    [o.ownerPhoneSet, 'Укажите свой личный номер — туда придут уведомления', '#settings'],
    [wa, 'Подключите WhatsApp — бот загрузит вашу прошлую переписку', '#connect'],
    [o.study?.last && !o.study.last.empty, o.study?.running ? `Бот изучает, как вы пишете клиентам… ${o.study.done}/${o.study.total}` : 'Бот изучает, как вы пишете клиентам, и пишет так же', '#learn'],
    [ch.instagram?.state === 'connected', 'Подключите Instagram (по желанию)', '#connect'],
  ];
  const allDone = steps.slice(0, 7).every((s) => s[0]);
  const t = st.totals;
  main.innerHTML = `
    <div class="page-head"><div><h1>Ассаламу алейкум!</h1><p class="muted">ИИ: ${esc(o.ai.name)} · WhatsApp: ${chState(ch.waqr?.state === 'connected' ? ch.waqr : ch.wacloud)} · Instagram: ${chState(ch.instagram)}</p></div></div>
    ${allDone ? '' : `<div class="card"><h2>С чего начать</h2><ol class="steps">${steps.map(([done, text, href]) => `<li class="${done ? 'done' : ''}"><span class="grow">${esc(text)}</span>${done ? '' : `<a class="btn sm" href="${href}">Перейти</a>`}</li>`).join('')}</ol></div>`}
    <div class="grid c2" style="margin-top:14px">
      <div class="card">
        <h2>Ждут вас ${att.length ? `<span class="tag gold">${att.length}</span>` : ''}</h2>
        ${att.length ? att.slice(0, 8).map((c) => `<a class="chat-item att" href="#chat/${c.id}"><div class="t"><b>${esc(nameOf(c))}</b><small class="muted">${fTime(c.last_at)}</small></div><div class="s">🔔 ${esc(c.attention_reason)}</div></a>`).join('') : '<p class="muted">Никто не ждёт — бот справляется.</p>'}
        <div class="row" style="margin-top:10px">
          ${o.counts.claimed ? `<a class="btn sm" href="#bookings">💰 Проверить оплаты: ${o.counts.claimed}</a>` : ''}
          ${o.counts.questions ? `<a class="btn sm" href="#learn">❓ Вопросы без ответа: ${o.counts.questions}</a>` : ''}
          ${o.counts.proposals ? `<a class="btn sm" href="#learn">💡 Бот предлагает уроков: ${o.counts.proposals}</a>` : ''}
        </div>
      </div>
      <div class="card">
        <h2>Последние 7 дней</h2>
        <div class="kpis" style="grid-template-columns:repeat(2,1fr);margin:0">
          <div class="kpi"><small>Новых клиентов</small><b>${t.newContacts}</b></div>
          <div class="kpi"><small>Броней</small><b>${t.bookings}</b></div>
          <div class="kpi"><small>Получено оплат</small><b>${fMoney(t.paid)}</b></div>
          <div class="kpi"><small>Бот ответил / вы</small><b>${t.byBot} / ${t.byOwner}</b></div>
        </div>
        <p style="margin:10px 0 0"><a href="#stats">Вся аналитика →</a></p>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h2>Уведомления</h2>
      ${o.events.length ? o.events.map((e) => `<div class="lesson"><small class="muted" style="width:90px;flex:none">${fTime(e.at)}</small><div class="txt">${esc(String(e.data.text || e.data.error || e.data.message || e.type).replace(/\n?[^\n]*https?:\/\/localhost\S*/g, ''))}</div>${e.contact_id ? `<a class="btn sm" href="#chat/${e.contact_id}">Открыть</a>` : ''}</div>`).join('') : '<p class="muted">Пока пусто.</p>'}
    </div>
    ${o.lastReview ? `<div class="card"><h2>Последний разбор дня <small class="muted">${fTime(o.lastReview.at)}</small></h2><div class="pre">${esc(o.lastReview.report)}</div></div>` : ''}`;
  every(15000, () => { if (!location.hash || location.hash === '#home') route(); });
};
function chState(s) {
  const st = s?.state || 'off';
  return st === 'connected' ? '<span class="dot on"></span> работает' : st === 'qr' ? '<span class="dot wait"></span> ждёт QR-код' : st === 'connecting' ? '<span class="dot wait"></span> подключается' : st === 'setup' ? '<span class="dot wait"></span> не настроен' : '<span class="dot off"></span> выключен';
}

// ======================= ДИАЛОГИ =======================
let chatFilter = '', chatSearch = '';
PAGES.chats = async (id) => {
  main.innerHTML = `
    <div class="chats">
      <div class="card chat-list">
        <div class="filters">
          <input id="chatSearch" placeholder="Поиск: имя, телефон, отель…" value="${esc(chatSearch)}">
          <select id="chatFilter">
            <option value="">Все клиенты</option><option value="attention">🔔 Ждут вас</option><option value="owner">✋ Ведёте сами</option><option value="archive">📚 Архив — прошлая переписка</option>
            ${Object.entries(STAGE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
        </div>
        <div class="items" id="chatItems"><div class="empty"><span class="spin"></span></div></div>
      </div>
      <div id="chatPane" class="chat-view">${id ? '' : '<div class="card empty" style="grid-column:1/-1">Выберите клиента слева.<br><br>Здесь видна вся переписка бота. Можно ответить самому, исправить ответ бота (так он учится) и выключить бота в отдельном чате.</div>'}</div>
    </div>`;
  $('#chatFilter').value = chatFilter;
  $('#chatFilter').onchange = (e) => { chatFilter = e.target.value; loadChatList(id); };
  let st; $('#chatSearch').oninput = (e) => { chatSearch = e.target.value; clearTimeout(st); st = setTimeout(() => loadChatList(id), 300); };
  await loadChatList(id);
  if (id) { await openChat(Number(id)); every(3500, pollChat); }
  every(6000, () => loadChatList(id));
};
async function loadChatList(activeId) {
  const list = await api(`/api/contacts?filter=${encodeURIComponent(chatFilter)}&q=${encodeURIComponent(chatSearch)}`);
  const el = $('#chatItems'); if (!el) return;
  el.innerHTML = list.length ? list.map((c) => {
    const paused = c.mode === 'owner' || c.paused_until > Date.now();
    return `<a class="chat-item ${c.attention ? 'att' : ''} ${String(c.id) === String(activeId) ? 'active' : ''}" href="#chat/${c.id}">
      <div class="t"><b>${esc(nameOf(c))}</b>${paused ? '<span title="Бот молчит в этом чате">✋</span>' : ''}<small class="muted">${fTime(c.last_at)}</small></div>
      <div class="row" style="gap:6px;margin-top:3px"><small>${CH[c.channel] || ''}</small>${stageTag(c.stage)}</div>
      <div class="s">${c.attention ? '🔔 ' + esc(c.attention_reason) : `${c.last_author === 'bot' ? '🤖 ' : c.last_author === 'owner' ? 'Вы: ' : ''}${esc(c.last_text || '')}`}</div></a>`;
  }).join('') : '<div class="empty">Пока никого.<br>Клиенты появятся здесь, когда напишут в WhatsApp или Instagram.</div>';
}

let chatState = { id: null, lastKey: '' };
async function openChat(id) {
  const d = await api(`/api/contacts/${id}`);
  const c = d.contact;
  chatState = { id, lastKey: '' };
  const paused = c.paused_until > Date.now();
  const r = d.request || {};
  const hotels = JSON.parse(r.hotels || '[]');
  const contactLine = [c.phone ? `<a href="https://wa.me/${esc(c.phone)}" target="_blank">+${esc(c.phone)}</a>` : '', c.username ? `<a href="https://instagram.com/${esc(c.username)}" target="_blank">@${esc(c.username)}</a>` : '', c.lang ? `язык: ${esc(c.lang)}` : ''].filter(Boolean).join(' · ');
  $('#chatPane').innerHTML = `
    <div class="card conv">
      <div class="conv-head">
        <div class="row"><h2 style="margin:0" class="grow">${esc(nameOf(c))} <small class="muted">${CH[c.channel] || ''}</small></h2>
          <select id="cStage" style="width:auto">${Object.entries(STAGE).map(([k, v]) => `<option value="${k}" ${c.stage === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="muted small" style="margin-top:2px">${contactLine}</div>
        ${c.attention ? `<div class="note" style="margin-top:8px"><div class="row"><span class="grow">🔔 ${esc(c.attention_reason)}</span><button class="btn sm" id="cDone">Решено</button></div></div>` : ''}
        <div class="row" style="margin-top:8px">
          <label class="check" style="margin:0"><input type="checkbox" id="cBot" ${c.mode !== 'owner' ? 'checked' : ''}> Бот отвечает в этом чате</label>
          ${paused && c.mode !== 'owner' ? `<span class="tag gold">молчит до ${fTime(c.paused_until)}, потому что вы ответили сами</span><button class="btn sm" id="cResume">Вернуть бота сейчас</button>` : ''}
        </div>
      </div>
      <div class="msgs" id="msgs"></div>
      <div class="composer">
        <textarea id="ownerText" placeholder="Написать клиенту от себя… (Ctrl+Enter — отправить)"></textarea>
        <button class="btn primary" id="ownerSend">Отправить</button>
      </div>
    </div>
    <div class="side-info">
      <div class="card">
        <h3>Что хочет клиент</h3>
        <dl class="facts">
          ${factRow('Город', CITY[r.city] || r.city)}${factRow('Отели', hotels.join(', '))}
          ${factRow('Даты', r.check_in ? `${fDate(r.check_in)} — ${fDate(r.check_out)}${r.nights ? ` (${r.nights} н.)` : ''}` : r.nights ? `${r.nights} ночей` : '')}
          ${factRow('Гостей / номеров', [r.guests, r.rooms].filter(Boolean).join(' / '))}${factRow('Номер', r.room_type)}${factRow('Питание', r.meals)}
          ${factRow('Бюджет', r.budget ? `${fNum(r.budget)} ${r.currency || ''}` : '')}${factRow('Поездка', { umrah: 'Умра', hajj: 'Хадж', other: 'Другое' }[r.trip_type] || r.trip_type)}
          ${factRow('Пожелания', r.notes)}
        </dl>
        ${c.summary ? `<h3>Кратко</h3><p class="pre" style="margin-top:0">${esc(c.summary)}</p>` : ''}
        ${c.lost_reason && c.stage === 'lost' ? `<p><span class="tag red">Отказ</span> ${esc(c.lost_reason)}</p>` : ''}
      </div>
      <div class="card">
        <h3>Заметки о клиенте</h3>
        <textarea id="cNotes" rows="3" placeholder="Видны боту. Например: «постоянный клиент, скидка 5%»">${esc(c.notes)}</textarea>
      </div>
      <div class="card">
        <div class="row"><h3 class="grow" style="margin:0">Брони</h3><button class="btn sm" id="cNewBooking">＋ Бронь</button></div>
        ${d.bookings.length ? d.bookings.map((b) => `<div class="lesson"><div class="txt"><b>${esc(b.hotel || '—')}</b><br><small class="muted">${fDate(b.check_in)} — ${fDate(b.check_out)} · ${fNum(b.total)} ${esc(b.currency)} · ${BOOK_STATUS[b.status] || b.status}</small></div></div>`).join('') : '<p class="muted small">Нет</p>'}
        ${d.payments.length ? `<h3 style="margin-top:10px">Оплаты</h3>` + d.payments.map((p) => `<div class="small">${fTime(p.at)} · ${fNum(p.amount)} ${esc(p.currency)} · <span class="tag ${p.status === 'confirmed' ? 'green' : p.status === 'claimed' ? 'gold' : 'red'}">${PAY_STATUS[p.status]}</span></div>`).join('') : ''}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" id="cRethink" title="Бот ещё раз прочитает переписку и ответит">🤖 Пусть бот ответит</button>
        <button class="btn sm danger" id="cDelete">Удалить клиента</button>
      </div>
    </div>`;
  renderMessages(d.messages);
  $('#cStage').onchange = async (e) => {
    let lost_reason;
    if (e.target.value === 'lost') lost_reason = prompt('Почему клиент отказался? (для аналитики)', c.lost_reason || '') ?? '';
    await api(`/api/contacts/${id}`, { stage: e.target.value, lost_reason }); toast('Стадия сохранена');
  };
  $('#cBot').onchange = async (e) => { await api(`/api/contacts/${id}`, { mode: e.target.checked ? 'bot' : 'owner', resume: e.target.checked }); toast(e.target.checked ? 'Бот снова отвечает этому клиенту' : 'В этом чате бот молчит — отвечаете вы'); openChat(id); };
  $('#cResume') && ($('#cResume').onclick = async () => { await api(`/api/contacts/${id}`, { resume: true }); openChat(id); });
  $('#cDone') && ($('#cDone').onclick = async () => { await api(`/api/contacts/${id}`, { attention: 0 }); refreshOverview(); openChat(id); loadChatList(id); });
  $('#cNotes').onchange = async (e) => { await api(`/api/contacts/${id}`, { notes: e.target.value }); toast('Заметка сохранена'); };
  $('#cNewBooking').onclick = () => bookingModal({ contact_id: id, hotel: hotels[0] || '', city: r.city === 'both' ? '' : r.city, check_in: r.check_in, check_out: r.check_out, guests: r.guests, rooms: r.rooms, room_type: r.room_type, currency: r.currency }, () => openChat(id));
  $('#cRethink').onclick = async () => { await api(`/api/contacts/${id}/rethink`, {}); toast('Бот думает над ответом…'); };
  $('#cDelete').onclick = async () => {
    if (!confirm('Удалить клиента и всю переписку из Вакиля? В самом WhatsApp/Instagram ничего не удалится.')) return;
    await api(`/api/contacts/${id}/delete`, {}); location.hash = '#chats';
  };
  const send = () => busy($('#ownerSend'), async () => {
    const text = $('#ownerText').value.trim(); if (!text) return;
    await api(`/api/contacts/${id}/send`, { text }); $('#ownerText').value = ''; await pollChat();
  });
  $('#ownerSend').onclick = send;
  $('#ownerText').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
}
const factRow = (k, v) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');
async function pollChat() {
  if (!chatState.id || !$('#msgs')) return;
  const d = await api(`/api/contacts/${chatState.id}`);
  renderMessages(d.messages);
}
function mediaHtml(m) {
  if (!m.media_kind) return '';
  const file = m.media_path ? `/api/media/${encodeURIComponent(m.media_path.split(/[\\/]/).pop())}` : '';
  if (m.media_kind === 'image' && file) return `<a href="${file}" target="_blank"><img src="${file}" alt="фото"></a>`;
  if (m.media_kind === 'audio' && file) return `<audio controls src="${file}" style="max-width:240px"></audio><br>`;
  return `<span class="muted">[${({ image: 'фото', audio: 'голосовое', video: 'видео', document: 'файл', sticker: 'стикер' })[m.media_kind] || 'вложение'}]</span> `;
}
function renderMessages(msgs, el = $('#msgs'), opts = {}) {
  if (!el) return;
  const key = msgs.map((m) => m.id + (m.corrected ? 'c' : '')).join(',') + (opts.typing ? 't' : '');
  if (el.dataset.key === key) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80 || !el.dataset.key;
  el.dataset.key = key;
  el.innerHTML = msgs.map((m) => `<div class="msg ${m.dir === 'out' ? 'out' : ''} ${m.author === 'owner' ? 'owner' : ''}">`
    + `${mediaHtml(m)}<div class="mt">${esc(m.text)}</div>`
    + (m.corrected ? `<div class="corr">✎ Как надо: ${esc(m.corrected)}</div>` : '')
    + `<div class="meta">${m.author === 'bot' ? '🤖 бот' : m.author === 'owner' ? '👤 вы' : ''} ${fTime(m.at)}`
    + (m.author === 'bot' && !opts.noFix ? ` <span class="fix" data-fix="${m.id}">✎ Исправить</span>` : '') + '</div></div>').join('') + (opts.typing ? '<div class="typing">бот печатает…</div>' : '') || '<div class="empty">Сообщений пока нет</div>';
  $$('[data-fix]', el).forEach((s) => (s.onclick = () => fixModal(msgs.find((m) => String(m.id) === s.dataset.fix))));
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function fixModal(m) {
  modal(`<h2>Исправить ответ бота</h2>
    <p class="muted">Бот запомнит, как надо, и в похожих случаях будет отвечать по-вашему. Клиенту ничего не отправится.</p>
    <div class="msg out" style="max-width:100%;margin-bottom:12px">${esc(m.text)}</div>
    <label class="f"><span>Как надо было ответить</span><textarea id="fxText" rows="5">${esc(m.corrected || m.text)}</textarea></label>
    <label class="f"><span>Почему (по желанию — помогает боту понять правило)</span><input id="fxWhy" placeholder="Например: не называй цену без дат"></label>
    <div class="row"><button class="btn primary" id="fxSave">Запомнить</button><button class="btn" data-close>Отмена</button></div>`, () => {
    $('#fxSave').onclick = () => busy($('#fxSave'), async () => {
      await api(`/api/messages/${m.id}/correct`, { text: $('#fxText').value, why: $('#fxWhy').value });
      closeModal(); toast('Запомнил. Урок добавлен в «Обучение».');
      chatState.lastKey = ''; const el = $('#msgs'); if (el) el.dataset.key = '';
      pollChat(); if (location.hash === '#test') route();
    });
  });
}

// ======================= БРОНИ И ОПЛАТЫ =======================
let contactsCache = null;
async function contactOptions(selected) {
  contactsCache = contactsCache || await api('/api/contacts');
  return `<option value="">— без клиента —</option>` + contactsCache.map((c) => `<option value="${c.id}" ${String(selected) === String(c.id) ? 'selected' : ''}>${esc(nameOf(c))}${c.phone ? ' +' + esc(c.phone) : ''}</option>`).join('');
}
async function bookingModal(b = {}, after) {
  contactsCache = null;
  const hotels = await api('/api/hotels');
  const cur = OV?.currency || '';
  modal(`<h2>${b.id ? 'Бронь №' + b.id : 'Новая бронь'}</h2>
    <div class="form-grid">
      <label class="f"><span>Клиент</span><select id="bk_contact_id">${await contactOptions(b.contact_id)}</select></label>
      <label class="f"><span>Отель</span><input id="bk_hotel" list="hotelList" value="${esc(b.hotel || '')}"><datalist id="hotelList">${hotels.map((h) => `<option value="${esc(h.name)}">`).join('')}</datalist></label>
      <label class="f"><span>Город</span><select id="bk_city"><option value="">—</option>${Object.entries(CITY).filter(([k]) => k !== 'both').map(([k, v]) => `<option value="${k}" ${b.city === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f"><span>Заезд</span><input type="date" id="bk_check_in" value="${esc(b.check_in || '')}"></label>
      <label class="f"><span>Выезд</span><input type="date" id="bk_check_out" value="${esc(b.check_out || '')}"></label>
      <label class="f"><span>Гостей</span><input type="number" id="bk_guests" value="${esc(b.guests ?? '')}"></label>
      <label class="f"><span>Номеров</span><input type="number" id="bk_rooms" value="${esc(b.rooms ?? '')}"></label>
      <label class="f"><span>Тип номера</span><input id="bk_room_type" value="${esc(b.room_type || '')}"></label>
      <label class="f"><span>Сумма для клиента</span><input type="number" step="any" id="bk_total" value="${esc(b.total ?? '')}"></label>
      <label class="f"><span>Валюта</span><input id="bk_currency" value="${esc(b.currency || cur || 'SAR')}"></label>
      <label class="f"><span>Ваша комиссия (доход)</span><input type="number" step="any" id="bk_commission" value="${esc(b.commission ?? '')}"></label>
      <label class="f"><span>Статус</span><select id="bk_status">${Object.entries(BOOK_STATUS).map(([k, v]) => `<option value="${k}" ${(b.status || 'pending') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <label class="f"><span>Заметка</span><textarea id="bk_note" rows="2">${esc(b.note || '')}</textarea></label>
    <div class="row"><button class="btn primary" id="bkSave">Сохранить</button><button class="btn" data-close>Отмена</button>
      ${b.id ? '<button class="btn danger right" id="bkDel">Удалить</button>' : ''}</div>`, () => {
    $('#bkSave').onclick = () => busy($('#bkSave'), async () => {
      const row = { id: b.id };
      for (const k of ['contact_id', 'hotel', 'city', 'check_in', 'check_out', 'guests', 'rooms', 'room_type', 'total', 'currency', 'commission', 'status', 'note']) row[k] = $('#bk_' + k).value;
      for (const k of ['guests', 'rooms', 'contact_id']) row[k] = row[k] === '' ? '' : Number(row[k]);
      await api('/api/bookings', row); closeModal(); toast('Бронь сохранена'); after?.();
    });
    $('#bkDel') && ($('#bkDel').onclick = async () => { if (confirm('Удалить бронь?')) { await api(`/api/bookings/${b.id}/delete`, {}); closeModal(); after?.(); } });
  });
}
async function paymentModal(p = {}, bookings = [], after) {
  modal(`<h2>${p.id ? 'Оплата' : 'Новая оплата'}</h2>
    ${p.media_path ? `<p><a href="/api/media/${encodeURIComponent(p.media_path.split(/[\\/]/).pop())}" target="_blank"><img src="/api/media/${encodeURIComponent(p.media_path.split(/[\\/]/).pop())}" style="max-width:240px;border-radius:8px"></a></p>` : ''}
    <div class="form-grid">
      <label class="f"><span>Бронь</span><select id="pm_booking_id"><option value="">—</option>${bookings.map((b) => `<option value="${b.id}" ${String(p.booking_id) === String(b.id) ? 'selected' : ''}>№${b.id} ${esc(b.contact_name || '')} — ${esc(b.hotel || '')} (${fNum(b.total)} ${esc(b.currency)})</option>`).join('')}</select></label>
      <label class="f"><span>Сумма</span><input type="number" step="any" id="pm_amount" value="${esc(p.amount ?? '')}"></label>
      <label class="f"><span>Валюта</span><input id="pm_currency" value="${esc(p.currency || 'SAR')}"></label>
      <label class="f"><span>Способ</span><input id="pm_method" value="${esc(p.method || '')}" placeholder="перевод, наличные…"></label>
      <label class="f"><span>Статус</span><select id="pm_status">${Object.entries(PAY_STATUS).map(([k, v]) => `<option value="${k}" ${(p.status || 'confirmed') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <label class="f"><span>Заметка</span><input id="pm_note" value="${esc(p.note || '')}"></label>
    <div class="row"><button class="btn primary" id="pmSave">Сохранить</button><button class="btn" data-close>Отмена</button>
      ${p.id ? '<button class="btn danger right" id="pmDel">Удалить</button>' : ''}</div>`, () => {
    $('#pmSave').onclick = () => busy($('#pmSave'), async () => {
      const row = { id: p.id, contact_id: p.contact_id };
      for (const k of ['booking_id', 'amount', 'currency', 'method', 'status', 'note']) row[k] = $('#pm_' + k).value;
      row.booking_id = row.booking_id ? Number(row.booking_id) : '';
      await api('/api/payments', row); closeModal(); toast('Оплата сохранена'); refreshOverview(); after?.();
    });
    $('#pmDel') && ($('#pmDel').onclick = async () => { if (confirm('Удалить оплату?')) { await api(`/api/payments/${p.id}/delete`, {}); closeModal(); after?.(); } });
  });
}
PAGES.bookings = async () => {
  const d = await api('/api/bookings');
  const claimed = d.payments.filter((p) => p.status === 'claimed');
  const confirmed = d.payments.filter((p) => p.status === 'confirmed');
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Брони и оплаты</h1><p class="muted">Бот сам отмечает, когда клиент пишет «оплатил» или присылает чек. Вы подтверждаете — и деньги попадают в аналитику.</p></div>
      <button class="btn primary" id="newB">＋ Бронь</button><button class="btn" id="newP">＋ Оплата</button></div>
    ${claimed.length ? `<div class="card"><h2>Клиенты сообщили об оплате — проверьте поступление</h2>
      ${claimed.map((p) => `<div class="lesson"><div class="txt"><b>${esc(p.contact_name || 'клиент #' + p.contact_id)}</b> · ${p.amount ? fNum(p.amount) + ' ' + esc(p.currency) : 'сумма не указана'} · <small class="muted">${fTime(p.at)}</small>${p.media_path ? ' · 📎 чек' : ''}</div>
        <button class="btn sm primary" data-pay="${p.id}">Проверить</button><a class="btn sm" href="#chat/${p.contact_id}">Чат</a><button class="btn sm danger" data-rej="${p.id}">Не пришла</button></div>`).join('')}</div>` : ''}
    <div class="card"><h2>Брони</h2>
      ${d.bookings.length ? `<div class="table-wrap"><table><tr><th>№</th><th>Клиент</th><th>Отель</th><th>Даты</th><th class="num">Гостей</th><th class="num">Сумма</th><th class="num">Оплачено</th><th class="num">Долг</th><th class="num">Комиссия</th><th>Статус</th></tr>
        ${d.bookings.map((b) => { const debt = (b.total || 0) - (b.paid || 0); return `<tr class="click" data-b="${b.id}"><td>${b.id}</td><td>${esc(b.contact_name || '—')}</td><td>${esc(b.hotel)}<br><small class="muted">${esc(CITY[b.city] || '')}</small></td>
          <td>${fDate(b.check_in)}<br><small class="muted">${fDate(b.check_out)}</small></td><td class="num">${fNum(b.guests)}</td><td class="num">${fNum(b.total)} ${esc(b.currency)}</td>
          <td class="num">${fNum(b.paid)}</td><td class="num ${debt > 0.5 && b.status !== 'cancelled' ? 'err' : ''}">${b.status === 'cancelled' ? '—' : fNum(Math.max(0, debt))}</td><td class="num">${fNum(b.commission)}</td>
          <td><span class="tag ${b.status === 'cancelled' ? 'red' : b.status === 'pending' ? 'gold' : 'green'}">${BOOK_STATUS[b.status]}</span></td></tr>`; }).join('')}</table></div>` : '<p class="muted">Броней пока нет. Создайте из карточки клиента в «Диалогах» или кнопкой «＋ Бронь».</p>'}
    </div>
    <div class="card"><h2>Полученные оплаты</h2>
      ${confirmed.length ? `<div class="table-wrap"><table><tr><th>Когда</th><th>Клиент</th><th>Бронь</th><th class="num">Сумма</th><th>Способ</th><th>Заметка</th></tr>
        ${confirmed.map((p) => `<tr class="click" data-p="${p.id}"><td>${fTime(p.at)}</td><td>${esc(p.contact_name || '—')}</td><td>${p.booking_id ? '№' + p.booking_id : '—'}</td><td class="num">${fNum(p.amount)} ${esc(p.currency)}</td><td>${esc(p.method)}</td><td>${esc(p.note)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Пока нет.</p>'}
    </div>
    <p class="muted small">Выгрузка в Excel: <a href="/api/export/bookings.csv">брони</a> · <a href="/api/export/payments.csv">оплаты</a></p>`;
  const reload = () => route();
  $('#newB').onclick = () => bookingModal({}, reload);
  $('#newP').onclick = () => paymentModal({}, d.bookings, reload);
  $$('[data-b]').forEach((tr) => (tr.onclick = () => bookingModal(d.bookings.find((b) => String(b.id) === tr.dataset.b), reload)));
  $$('[data-p]').forEach((tr) => (tr.onclick = () => paymentModal(d.payments.find((p) => String(p.id) === tr.dataset.p), d.bookings, reload)));
  $$('[data-pay]').forEach((b) => (b.onclick = () => paymentModal({ ...d.payments.find((p) => String(p.id) === b.dataset.pay), status: 'confirmed' }, d.bookings, reload)));
  $$('[data-rej]').forEach((b) => (b.onclick = async () => { await api('/api/payments', { id: Number(b.dataset.rej), status: 'rejected' }); refreshOverview(); reload(); }));
};

// ======================= АНАЛИТИКА =======================
let statDays = 30;
function hbars(items, { gold = false, fmt = fNum } = {}) {
  if (!items.length) return '<p class="muted small">Нет данных</p>';
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="bars">${items.map((i) => `<div class="bar"><span class="lbl" title="${esc(i.label ?? i.key)}">${esc(i.label ?? i.key)}</span><span class="track"><span class="fill ${gold ? 'gold' : ''}" style="width:${(i.value / max) * 100}%"></span></span><span class="v">${fmt(i.value)}</span></div>`).join('')}</div>`;
}
function vchart(series, keys, labels) {
  if (!series.length) return '';
  const W = 380, H = 170, n = series.length, bw = W / n;
  const max = Math.max(1, ...series.map((s) => keys.reduce((a, k) => a + (s[k] || 0), 0)));
  let bars = '';
  series.forEach((s, i) => {
    let y = H - 16;
    keys.forEach((k, j) => {
      const h = ((s[k] || 0) / max) * (H - 26);
      y -= h;
      if (h > 0) bars += `<rect class="${'ab'[j]}" x="${i * bw + bw * 0.15}" y="${y}" width="${bw * 0.7}" height="${h}" rx="2"><title>${s.day}: ${keys.map((kk, jj) => `${labels[jj]} ${s[kk]}`).join(', ')}</title></rect>`;
    });
  });
  const step = Math.ceil(n / 6);
  const ticks = series.map((s, i) => (i % step === 0 ? `<text x="${i * bw + bw / 2}" y="${H - 2}" font-size="10" text-anchor="middle" fill="#6b7c77">${s.day.slice(8)}.${s.day.slice(5, 7)}</text>` : '')).join('');
  return `<svg class="vchart" viewBox="0 0 ${W} ${H}">${bars}${ticks}</svg>
    <div class="legend">${labels.map((l, j) => `<span><i style="background:${j ? '#e0a43a' : '#0f766e'}"></i>${l}</span>`).join('')}</div>`;
}
PAGES.stats = async () => {
  const s = await api(`/api/stats?days=${statDays}`);
  const t = s.totals;
  const maxF = Math.max(1, s.funnel[0]?.value || 1);
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Аналитика</h1><p class="muted">Проверочные разговоры сюда не попадают.</p></div>
      <div class="row">${[[7, '7 дней'], [30, '30 дней'], [90, '3 месяца'], [365, 'Год'], [0, 'Всё время']].map(([d, l]) => `<button class="btn sm ${statDays === d ? 'primary' : ''}" data-days="${d}">${l}</button>`).join('')}</div></div>
    <div class="kpis">
      <div class="kpi"><small>Новых клиентов</small><b>${t.newContacts}</b></div>
      <div class="kpi"><small>Броней</small><b>${t.bookings}</b>${t.cancelled ? `<small>отменено: ${t.cancelled}</small>` : ''}</div>
      <div class="kpi"><small>Конверсия в бронь</small><b>${t.conversion == null ? '—' : t.conversion + '%'}</b></div>
      <div class="kpi"><small>Сумма броней</small><b>${fMoney(t.revenue)}</b></div>
      <div class="kpi"><small>Ваша комиссия</small><b>${fMoney(t.commission)}</b></div>
      <div class="kpi"><small>Получено оплат</small><b>${fMoney(t.paid)}</b></div>
      <div class="kpi ${Object.keys(t.debts).length ? 'warn' : ''}"><small>Долги клиентов (всего)</small><b>${fMoney(t.debts)}</b></div>
      <div class="kpi ${t.claimed.count ? 'warn' : ''}"><small>Ждут проверки оплаты</small><b>${t.claimed.count}</b></div>
      <div class="kpi"><small>Отказов</small><b>${t.lost}</b></div>
      <div class="kpi"><small>Первый ответ (медиана)</small><b>${t.firstResponseMedianSec == null ? '—' : t.firstResponseMedianSec < 120 ? Math.round(t.firstResponseMedianSec) + ' с' : Math.round(t.firstResponseMedianSec / 60) + ' мин'}</b></div>
      <div class="kpi"><small>Ответов бота / ваших</small><b>${t.byBot} / ${t.byOwner}</b>${t.botShare != null ? `<small>бот: ${t.botShare}%</small>` : ''}</div>
      <div class="kpi"><small>Передано вам</small><b>${t.handoffs}</b></div>
    </div>
    <div class="grid c2">
      <div class="card"><h2>Воронка</h2>${hbars(s.funnel.map((f) => ({ key: f.label, value: f.value })))}<p class="muted small">Сколько новых клиентов дошли до каждого шага.</p></div>
      <div class="card"><h2>По дням</h2>${vchart(s.timeline.slice(-60), ['contacts', 'bookings'], ['новые клиенты', 'брони'])}</div>
      <div class="card"><h2>Отели: интерес и брони</h2>
        ${s.hotels.length ? `<div class="table-wrap"><table><tr><th>Отель</th><th class="num">Интерес</th><th class="num">Брони</th><th class="num">Конверсия</th><th class="num">Сумма</th></tr>
          ${s.hotels.map((h) => `<tr><td>${esc(h.hotel)}</td><td class="num">${h.interest}</td><td class="num">${h.bookings}</td><td class="num">${h.interest ? Math.round((h.bookings / h.interest) * 100) + '%' : '—'}</td><td class="num">${fNum(h.revenue)}</td></tr>`).join('')}</table></div>
          <p class="muted small">Интерес — сколько разных клиентов спрашивали об отеле. Много интереса и мало броней — стоит проверить цену или условия.</p>` : '<p class="muted small">Нет данных</p>'}
      </div>
      <div class="card"><h2>Когда едут (месяц заезда)</h2>${hbars(s.months.map((m) => ({ key: m.key.split('-').reverse().join('.'), value: m.value })), { gold: true })}</div>
      <div class="card"><h2>Город</h2>${hbars(s.cities)}<h2 style="margin-top:14px">Поездка</h2>${hbars(s.tripTypes)}</div>
      <div class="card"><h2>Откуда клиенты</h2>${hbars(Object.entries(s.channels).map(([k, v]) => ({ key: k, value: v.contacts })))}
        <p class="muted small">${Object.entries(s.channels).map(([k, v]) => `${esc(k)}: броней ${v.bookings}`).join(' · ')}</p></div>
      <div class="card"><h2>Группы и бюджеты</h2>
        <dl class="facts"><dt>Гостей в среднем</dt><dd>${fNum(t.avgGuests)}</dd><dt>Ночей в среднем</dt><dd>${fNum(t.avgNights)}</dd>
        <dt>Бюджет (медиана)</dt><dd>${t.medianBudget?.value ? fNum(t.medianBudget.value) + ' ' + esc(t.medianBudget.currency) : '—'}</dd></dl>
        <h3>Типы номеров</h3>${hbars(s.roomTypes)}<h3 style="margin-top:10px">Питание</h3>${hbars(s.meals)}</div>
      <div class="card"><h2>Почему отказываются</h2>${hbars(s.lostReasons, { gold: true })}</div>
      <div class="card"><h2>Когда пишут клиенты (час)</h2>${hbars(s.hours.map((v, h) => ({ key: `${pad(h)}:00`, value: v })).filter((x) => x.value))}</div>
      <div class="card"><h2>Работа ИИ</h2><dl class="facts"><dt>Обращений к ИИ</dt><dd>${s.ai.calls}</dd><dt>Сбоев</dt><dd>${s.ai.errors}${s.ai.limits ? ` (лимит подписки: ${s.ai.limits})` : ''}</dd><dt>Время ответа (среднее)</dt><dd>${s.ai.avgSec ? s.ai.avgSec + ' с' : '—'}</dd></dl></div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Спросить аналитика</h2>
      <p class="muted">ИИ посмотрит на цифры и ответит. Например: «Какие отели чаще спрашивают, но не бронируют?», «Когда начинать рекламу на Рамадан?», «Почему падают продажи?». Имена и телефоны клиентов ИИ не получает.</p>
      <div class="row"><input id="aq" class="grow" placeholder="Ваш вопрос…"><button class="btn primary" id="aqBtn">Спросить</button></div>
      <div id="aqOut" style="margin-top:12px"></div></div>
    <p class="muted small">Выгрузка в Excel: ${['clients', 'requests', 'bookings', 'payments'].map((n) => `<a href="/api/export/${n}.csv">${{ clients: 'клиенты', requests: 'заявки', bookings: 'брони', payments: 'оплаты' }[n]}</a>`).join(' · ')}</p>`;
  $$('[data-days]').forEach((b) => (b.onclick = () => { statDays = Number(b.dataset.days); route(); }));
  const askA = () => busy($('#aqBtn'), async () => {
    const q = $('#aq').value.trim(); if (!q) return;
    $('#aqOut').textContent = 'Думаю… (до пары минут)';
    const r = await api('/api/analyst', { question: q, days: statDays || 0 });
    $('#aqOut').innerHTML = mdLite(r.text);
  });
  $('#aqBtn').onclick = askA;
  $('#aq').onkeydown = (e) => { if (e.key === 'Enter') askA(); };
};

// ======================= ОБУЧЕНИЕ =======================
const SRC = { owner: 'вы', correction: 'исправление', review: 'разбор дня', teach: 'из чата', history: 'из переписки' };

// ---------- изучение прошлой переписки ----------
function studyStatusHtml(st) {
  if (st.running) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 5;
    return `<p><span class="spin"></span> ${esc(st.phase || 'Изучаю')}… ${st.total ? `${st.done} из ${st.total}` : ''}</p>
      <div class="bar" style="grid-template-columns:1fr"><span class="track"><span class="fill" style="width:${pct}%"></span></span></div>
      <p class="muted small">Можно закрыть панель — бот доизучит сам и пришлёт вам итог. ${OV?.botEnabled ? 'Пока идёт изучение, клиентам он не отвечает (не дольше 30 минут).' : ''}</p>`;
  }
  const l = st.last;
  return `${st.error ? `<p class="err">Не получилось: ${esc(st.error)}</p>` : ''}
    ${l ? `<p><b>${l.empty ? 'Изучать пока нечего.' : `Изучено ${fTime(l.at)}: чатов ${l.chats}, ваших ответов ${l.messages}.`}</b></p><div class="pre">${esc(l.report || '')}</div>`
      : '<p>Бот ещё не изучал вашу переписку.</p>'}`;
}
async function uploadExports(files) {
  const batch = Math.random().toString(36).slice(2);
  let ok = 0;
  for (const f of files) {
    if (f.size > 80 * 1024 * 1024) { toast(`${f.name}: слишком большой файл. Экспортируйте чат «Без медиафайлов».`, true); continue; }
    toast(`Загружаю ${f.name}…`);
    const r = await fetch(`/api/study/upload?batch=${batch}&name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'x-wakil': '1' }, body: f });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || 'Не загрузилось', true); continue; }
    ok++;
  }
  if (ok) await finishImport(batch, '');
}
async function finishImport(batch, ownerName) {
  const r = await api('/api/study/import', { batch, ownerName });
  if (r.needOwner) {
    modal(`<h2>Какое из имён — ваше?</h2><p class="muted">В загруженных чатах несколько авторов. Выберите себя, чтобы бот учился именно на ваших ответах.</p>
      <div class="row" style="flex-direction:column;align-items:stretch">${r.authors.map((a) => `<button class="btn" data-owner="${esc(a)}">${esc(a)}</button>`).join('')}</div>`, () => {
      $$('[data-owner]').forEach((b) => (b.onclick = () => { closeModal(); finishImport(batch, b.dataset.owner); }));
    });
    return;
  }
  if (!r.ok) return toast(r.error, true);
  const old = r.tooOld ? ` Пропущено как слишком старые (старше ${r.months} мес.): ${r.tooOld} — срок меняется в «Настройках».` : '';
  if (!r.chats) return toast((r.tooOld ? 'Новых чатов не нашлось.' : 'Новых чатов не нашлось — возможно, они уже загружены.') + old, true);
  toast(`Загружено чатов: ${r.chats}, сообщений: ${r.messages}.${old} Начинаю изучать.`);
  await api('/api/study/run', { mode: 'full' });
  route();
}
function studyCardHtml(st, igOn, waOn) {
  const h = st.history;
  return `<div class="card" id="studyCard" style="margin-bottom:14px">
    <h2>📚 Как вы пишете клиентам — бот пишет так же</h2>
    <div id="stStatus">${studyStatusHtml(st)}</div>
    <p class="muted small" style="margin-bottom:4px">Откуда бот берёт вашу переписку:</p>
    <ul class="small" style="margin-top:0">
      <li><b>WhatsApp по QR-коду</b> — при подключении сам загружает ваши чаты за последние ${esc(String(st.months || 12))} мес.${!h && waOn ? ' <span class="muted">(WhatsApp был подключён раньше этой функции — чтобы загрузить историю, отвяжите и подключите его заново в «Подключениях».)</span>' : ''}</li>
      <li><b>Экспорт чатов</b> WhatsApp (.txt или .zip) или выгрузка Instagram (.json) — загрузите кнопкой ниже. Подходит и для официального WhatsApp.</li>
    </ul>
    ${h ? `<p class="small">Всего загружено прошлой переписки: чатов ${h.chats}, сообщений ${h.messages}. Её можно посмотреть в «Диалогах» → «Архив».</p>` : ''}
    <div class="row">
      <label class="btn">📎 Загрузить экспорт чатов<input type="file" id="stFiles" multiple accept=".txt,.zip,.json" hidden></label>
      ${igOn ? '<button class="btn" id="stIg">Загрузить переписку из Instagram</button>' : ''}
      <button class="btn ${st.last ? '' : 'primary'}" id="stRun" ${st.running ? 'disabled' : ''}>${st.last && !st.last.empty ? 'Изучить заново' : 'Изучить сейчас'}</button>
    </div>
    <details style="margin-top:8px"><summary class="muted small">Как сделать экспорт чата в WhatsApp</summary>
      <ul class="small"><li><b>iPhone:</b> откройте чат → нажмите на имя вверху → «Экспорт чата» → «Без медиафайлов» → сохраните в «Файлы» или отправьте себе.</li>
      <li><b>Android:</b> откройте чат → ⋮ → «Ещё» → «Экспорт чата» → «Без медиафайлов».</li>
      <li>Сделайте так для 10–30 чатов с клиентами, где вы отвечали сами, — и загрузите все файлы разом.</li>
      <li><b>Instagram:</b> Настройки → «Ваши действия» → «Скачать информацию» → «Сообщения», формат <b>JSON</b>. Загрузите файлы <code>message_1.json</code> или весь архив .zip.</li></ul>
    </details>
  </div>`;
}
function styleCardHtml(d) {
  const p = d.profile;
  return `<div class="card" style="margin-top:14px"><h2>Ваш стиль — так бот пишет от вашего имени</h2>
    ${p?.text ? `<p class="muted small">Бот составил это по вашей переписке${p.edited ? ' (вы правили вручную)' : ''}. Поправьте, если что-то не так, — это главная инструкция о том, как ему писать.</p>
      <textarea id="stProfile" rows="14">${esc(p.text)}</textarea><div class="row" style="margin-top:8px"><button class="btn primary" id="stSave">Сохранить</button></div>`
      : '<p class="muted">Появится после изучения переписки.</p>'}
    ${d.examples.length ? `<details style="margin-top:12px"><summary><b>Ваши настоящие ответы, по которым бот учится (${d.examples.length})</b></summary>
      ${d.examples.map((e, i) => `<div class="lesson"><div class="txt"><small class="muted">${esc(e.situation)}</small><br><b>Клиент:</b> ${esc(e.client)}<br><b>Вы:</b> ${esc(e.owner)}</div><button class="btn sm danger" data-exdel="${i}" title="Не брать за образец">✕</button></div>`).join('')}
    </details>` : ''}
  </div>`;
}
function bindStudy(st) {
  $('#stFiles').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) uploadExports(files).catch((err) => toast(err.message, true)); };
  $('#stRun').onclick = async () => {
    if (st.last && !st.last.empty && !confirm('Изучить всю переписку заново? Профиль стиля будет составлен заново (ваши ручные правки в нём заменятся).')) return;
    await api('/api/study/run', { mode: 'full' }); toast('Начал изучать'); route();
  };
  $('#stIg') && ($('#stIg').onclick = () => busy($('#stIg'), async () => {
    const r = await api('/api/study/instagram', {});
    if (!r.chats) return toast('Новых диалогов не нашлось');
    toast(`Загружено диалогов: ${r.chats}. Начинаю изучать.`); await api('/api/study/run', { mode: 'full' }); route();
  }));
  $('#stSave') && ($('#stSave').onclick = async () => { await api('/api/study/profile', { text: $('#stProfile').value }); toast('Сохранено — бот уже пишет по-новому'); });
  $$('[data-exdel]').forEach((b) => (b.onclick = async () => { await api(`/api/study/examples/${b.dataset.exdel}/delete`, {}); route(); }));
  if (st.running) {
    every(3000, async () => {
      const s = await api('/api/study');
      if (!s.running) return route();
      const el = $('#stStatus'); if (el) el.innerHTML = studyStatusHtml(s);
    });
  }
}
PAGES.learn = async () => {
  const [d, st] = await Promise.all([api('/api/learning'), api('/api/study')]);
  await refreshOverview();
  const igOn = OV?.channels?.instagram?.state === 'connected';
  const waOn = OV?.channels?.waqr?.state === 'connected';
  const proposed = d.lessons.filter((l) => l.status === 'proposed');
  const active = d.lessons.filter((l) => l.status === 'active');
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Обучение</h1><p class="muted">Бот учится на вашей переписке, на ваших исправлениях и на том, что вы ему говорите.</p></div></div>
    ${studyCardHtml(st, igOn, waOn)}
    <div class="grid c2">
      <div class="card teach">
        <div class="row"><h2 class="grow" style="margin:0">Чат с ботом-учеником</h2><button class="btn sm" id="tClear">Очистить</button></div>
        <p class="muted small" style="margin:6px 0">Пишите как сотруднику: «Запомни: в Рамадан минимум 5 ночей», «Вот прайс на декабрь: …», «Какие вопросы ты не знал?». Можно писать и со своего личного WhatsApp на номер бота.</p>
        <div class="msgs" id="tMsgs"></div>
        <div class="composer" style="padding:10px 0 0;border:0"><textarea id="tText" placeholder="Напишите боту… (Ctrl+Enter — отправить)"></textarea><button class="btn primary" id="tSend">Отправить</button></div>
      </div>
      <div>
        ${proposed.length ? `<div class="card"><div class="row"><h2 class="grow" style="margin:0">Бот предлагает уроки <span class="tag gold">${proposed.length}</span></h2>${proposed.length > 1 ? '<button class="btn sm" id="okAll">Одобрить все</button>' : ''}</div><p class="muted small">Из вашей переписки и разбора дня. Одобрите полезные — бот начнёт им следовать. Проверьте цены и сроки: они могли устареть.</p>
          ${proposed.map((l) => `<div class="lesson"><div class="txt">${esc(l.text)}${l.why ? `<br><small class="muted">Почему: ${esc(l.why)}</small>` : ''}</div>
            <button class="btn sm primary" data-ok="${l.id}">Да</button><button class="btn sm" data-edit="${l.id}">✎</button><button class="btn sm danger" data-no="${l.id}">Нет</button></div>`).join('')}</div>` : ''}
        <div class="card"><h2>Вопросы клиентов без ответа ${d.questions.length ? `<span class="tag gold">${d.questions.length}</span>` : ''}</h2>
          ${d.questions.length ? d.questions.map((q) => `<div class="lesson" style="flex-direction:column;align-items:stretch"><div><b>${esc(q.text)}</b> <small class="muted">${fTime(q.at)}${q.contact_id ? ` · <a href="#chat/${q.contact_id}">чат</a>` : ''}</small></div>
            <div class="row"><input class="grow" data-qa="${q.id}" placeholder="Ваш ответ — бот запомнит"><button class="btn sm primary" data-qsave="${q.id}">Ответить</button><button class="btn sm" data-qign="${q.id}">Не важно</button></div></div>`).join('') : '<p class="muted small">Таких нет. Когда бот не будет знать ответа, вопрос появится здесь.</p>'}
        </div>
        <div class="card"><div class="row"><h2 class="grow" style="margin:0">Разбор дня</h2><button class="btn sm" id="rvRun">Разобрать сейчас</button></div>
          <p class="muted small">Каждый вечер бот сам перечитывает переписку, ищет свои ошибки и предлагает уроки.${d.autoApprove ? ' Уроки применяются сразу (включено в настройках).' : ''}</p>
          <div class="pre" id="rvOut">${d.lastReview ? `<small class="muted">${fTime(d.lastReview.at)}</small>\n${esc(d.lastReview.report)}` : '<span class="muted">Ещё не было.</span>'}</div></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Уроки, которым бот следует <span class="tag">${active.length}</span></h2>
      <div class="row" style="margin-bottom:8px"><input id="lNew" class="grow" placeholder="Новое правило, например: «Всегда уточняй, нужен ли номер с видом на Каабу»"><button class="btn primary" id="lAdd">Добавить</button></div>
      ${active.map((l) => `<div class="lesson"><div class="txt">${esc(l.text)}</div><span class="tag">${l.kind === 'example' ? 'пример' : l.kind === 'faq' ? 'вопрос-ответ' : 'правило'}</span><span class="tag">${SRC[l.source] || l.source}</span>
        <button class="btn sm" data-edit="${l.id}">✎</button><button class="btn sm danger" data-del="${l.id}">✕</button></div>`).join('') || '<p class="muted">Пока нет.</p>'}
    </div>
    ${styleCardHtml(st)}`;
  bindStudy(st);
  const renderT = (h) => renderMessages(h.map((x, i) => ({ id: i, dir: x.who === 'owner' ? 'out' : 'in', author: x.who === 'owner' ? 'owner' : 'teacher', text: x.text, at: x.at })), $('#tMsgs'), { noFix: true });
  renderT(d.history);
  const sendT = () => busy($('#tSend'), async () => {
    const text = $('#tText').value.trim(); if (!text) return;
    const h = [...d.history, { who: 'owner', text, at: Date.now() }];
    renderMessages(h.map((x, i) => ({ id: i, dir: x.who === 'owner' ? 'out' : 'in', author: x.who === 'owner' ? 'owner' : 'teacher', text: x.text, at: x.at })), $('#tMsgs'), { noFix: true, typing: true });
    $('#tText').value = '';
    const r = await api('/api/teach', { text });
    if (!r.ok) toast(r.reply, true);
    if (r.done?.length) toast('Сделано: ' + r.done.join('; '));
    route();
  });
  $('#tSend').onclick = sendT;
  $('#tText').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendT(); } };
  $('#tClear').onclick = async () => { await api('/api/teach/clear', {}); route(); };
  $('#lAdd').onclick = async () => { const t = $('#lNew').value.trim(); if (!t) return; await api('/api/lessons', { text: t }); toast('Урок добавлен'); route(); };
  $$('[data-ok]').forEach((b) => (b.onclick = async () => { await api(`/api/lessons/${b.dataset.ok}`, { status: 'active' }); refreshOverview(); route(); }));
  $('#okAll') && ($('#okAll').onclick = async () => {
    if (!confirm(`Одобрить все ${proposed.length} уроков? Проверьте, что в них нет устаревших цен.`)) return;
    for (const l of proposed) await api(`/api/lessons/${l.id}`, { status: 'active' });
    toast('Одобрено'); refreshOverview(); route();
  });
  $$('[data-no]').forEach((b) => (b.onclick = async () => { await api(`/api/lessons/${b.dataset.no}`, { status: 'rejected' }); refreshOverview(); route(); }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Удалить урок?')) { await api(`/api/lessons/${b.dataset.del}/delete`, {}); route(); } }));
  $$('[data-edit]').forEach((b) => (b.onclick = () => {
    const l = d.lessons.find((x) => String(x.id) === b.dataset.edit);
    modal(`<h2>Урок</h2><textarea id="leText" rows="6">${esc(l.text)}</textarea><div class="row" style="margin-top:10px"><button class="btn primary" id="leSave">Сохранить${l.status === 'proposed' ? ' и одобрить' : ''}</button><button class="btn" data-close>Отмена</button></div>`, () => {
      $('#leSave').onclick = async () => { await api(`/api/lessons/${l.id}`, { text: $('#leText').value, ...(l.status === 'proposed' ? { status: 'active' } : {}) }); closeModal(); route(); };
    });
  }));
  $$('[data-qsave]').forEach((b) => (b.onclick = async () => {
    const a = $(`[data-qa="${b.dataset.qsave}"]`).value.trim(); if (!a) return toast('Напишите ответ', true);
    await api(`/api/questions/${b.dataset.qsave}`, { answer: a }); toast('Запомнил'); refreshOverview(); route();
  }));
  $$('[data-qign]').forEach((b) => (b.onclick = async () => { await api(`/api/questions/${b.dataset.qign}`, { ignore: true }); refreshOverview(); route(); }));
  $('#rvRun').onclick = () => busy($('#rvRun'), async () => {
    $('#rvOut').textContent = 'Перечитываю переписку за сутки… Это может занять несколько минут.';
    const r = await api('/api/review', { hours: 24 });
    $('#rvOut').textContent = r.ok ? r.report : 'Не получилось: ' + r.message;
    if (r.ok && r.proposals) route();
  });
};

// ======================= ОТЕЛИ И ЗНАНИЯ =======================
let kbFile = null;
PAGES.knowledge = async () => {
  const [hotels, files] = await Promise.all([api('/api/hotels'), api('/api/knowledge')]);
  const today = new Date().toISOString().slice(0, 10);
  if (!kbFile || !files.find((f) => f.name === kbFile)) kbFile = files[0]?.name || null;
  const cur = files.find((f) => f.name === kbFile);
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Отели и знания</h1><p class="muted">Бот отвечает только по тому, что здесь написано. Чего здесь нет — он не выдумывает, а зовёт вас.</p></div></div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Отели и цены</h2><button class="btn primary" id="hNew">＋ Отель</button></div>
      <p class="muted small">Быстрее всего: откройте «Обучение» и вставьте прайс текстом — бот сам разнесёт его по карточкам. Если цены устарели (дата прошла), бот их не называет и зовёт вас.</p>
      ${hotels.length ? `<div class="table-wrap"><table><tr><th>Отель</th><th>Город</th><th>★</th><th>До Харама</th><th>Цены до</th><th></th></tr>
        ${hotels.map((h) => `<tr class="click" data-h="${h.id}"><td><b>${esc(h.name)}</b>${h.area ? `<br><small class="muted">${esc(h.area)}</small>` : ''}</td><td>${esc(CITY[h.city] || h.city)}</td><td>${h.stars || ''}</td><td>${esc(h.distance)}</td>
          <td>${h.prices ? (h.prices_until ? `<span class="tag ${h.prices_until < today ? 'red' : 'green'}">${fDate(h.prices_until)}</span>` : '<span class="tag gold">без даты</span>') : '<span class="tag">нет цен</span>'}</td>
          <td>${h.active ? '' : '<span class="tag">скрыт</span>'}</td></tr>`).join('')}</table></div>` : '<p class="muted">Отелей пока нет.</p>'}
    </div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Знания о компании</h2><button class="btn sm" id="kNew">＋ Раздел</button></div>
      <p class="muted small">Пишите обычным языком. Места в [квадратных скобках] бот считает незаполненными.</p>
      <div class="row" style="margin:8px 0">${files.map((f) => `<button class="btn sm ${f.name === kbFile ? 'primary' : ''}" data-kf="${esc(f.name)}">${esc(f.name.replace(/\.md$/, ''))}</button>`).join('')}</div>
      ${cur ? `<input id="kName" value="${esc(cur.name.replace(/\.md$/, ''))}" style="margin-bottom:8px"><textarea id="kText" rows="18">${esc(cur.text)}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="kSave">Сохранить</button><button class="btn danger right" id="kDel">Удалить раздел</button></div>` : ''}
    </div>`;
  $('#hNew').onclick = () => hotelModal({ active: 1 });
  $$('[data-h]').forEach((tr) => (tr.onclick = () => hotelModal(hotels.find((h) => String(h.id) === tr.dataset.h))));
  $$('[data-kf]').forEach((b) => (b.onclick = () => { kbFile = b.dataset.kf; route(); }));
  $('#kNew').onclick = async () => { const n = prompt('Название раздела, например «Трансфер и визы»'); if (!n) return; await api('/api/knowledge', { name: n, text: `# ${n}\n\n` }); kbFile = n.endsWith('.md') ? n : n + '.md'; route(); };
  if (cur) {
    $('#kSave').onclick = () => busy($('#kSave'), async () => { const name = $('#kName').value.trim() || cur.name; await api('/api/knowledge', { oldName: cur.name, name, text: $('#kText').value }); kbFile = name.endsWith('.md') ? name : name + '.md'; toast('Сохранено — бот уже знает'); route(); });
    $('#kDel').onclick = async () => { if (confirm(`Удалить раздел «${cur.name}»?`)) { await api('/api/knowledge/delete', { name: cur.name }); kbFile = null; route(); } };
  }
};
function hotelModal(h) {
  modal(`<h2>${h.id ? esc(h.name) : 'Новый отель'}</h2>
    <div class="form-grid">
      <label class="f"><span>Название</span><input id="h_name" value="${esc(h.name || '')}"></label>
      <label class="f"><span>Город</span><select id="h_city"><option value="makkah" ${h.city === 'makkah' ? 'selected' : ''}>Мекка</option><option value="madinah" ${h.city === 'madinah' ? 'selected' : ''}>Медина</option><option value="other" ${h.city === 'other' ? 'selected' : ''}>Другое</option></select></label>
      <label class="f"><span>Звёзд</span><input type="number" id="h_stars" value="${esc(h.stars ?? '')}"></label>
      <label class="f"><span>До Харама</span><input id="h_distance" value="${esc(h.distance || '')}" placeholder="первая линия / 300 м / 5 мин пешком"></label>
      <label class="f"><span>Район</span><input id="h_area" value="${esc(h.area || '')}" placeholder="Ибрагим Халиль, Аджьяд…"></label>
      <label class="f"><span>Цены актуальны до</span><input type="date" id="h_prices_until" value="${esc(h.prices_until || '')}"></label>
    </div>
    <label class="f"><span>Описание для клиентов</span><textarea id="h_description" rows="3" placeholder="Завтрак, вид на Каабу, семейные номера, лифты…">${esc(h.description || '')}</textarea></label>
    <label class="f"><span>Цены (как в прайсе)</span><textarea id="h_prices" rows="4" placeholder="Двухместный — 450 SAR/ночь, завтрак&#10;Трёхместный — 520 SAR/ночь&#10;В Рамадан ×2, минимум 5 ночей">${esc(h.prices || '')}</textarea></label>
    <label class="f"><span>Только для вас (бот клиентам не скажет): комиссия, контакты отеля</span><textarea id="h_private_note" rows="2">${esc(h.private_note || '')}</textarea></label>
    <label class="check"><input type="checkbox" id="h_active" ${h.active ? 'checked' : ''}> Предлагать клиентам</label>
    <div class="row"><button class="btn primary" id="hSave">Сохранить</button><button class="btn" data-close>Отмена</button>${h.id ? '<button class="btn danger right" id="hDel">Удалить</button>' : ''}</div>`, () => {
    $('#hSave').onclick = () => busy($('#hSave'), async () => {
      const row = { id: h.id };
      for (const k of ['name', 'city', 'stars', 'distance', 'area', 'prices_until', 'description', 'prices', 'private_note']) row[k] = $('#h_' + k).value;
      row.active = $('#h_active').checked;
      if (!row.name.trim()) throw new Error('Напишите название');
      await api('/api/hotels', row); closeModal(); toast('Сохранено'); route();
    });
    $('#hDel') && ($('#hDel').onclick = async () => { if (confirm('Удалить отель?')) { await api(`/api/hotels/${h.id}/delete`, {}); closeModal(); route(); } });
  });
}

// ======================= ПРОВЕРИТЬ БОТА =======================
PAGES.test = async () => {
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Проверить бота</h1><p class="muted">Пишите как клиент. Бот ответит так же, как ответил бы в WhatsApp. Неудачный ответ — нажмите «✎ Исправить», и бот запомнит. В аналитику эти разговоры не попадают.</p></div>
      <button class="btn" id="tsReset">Начать заново</button></div>
    <div class="chat-view">
      <div class="card conv" style="height:calc(100vh - 160px);min-height:420px">
        <div class="msgs" id="tsMsgs"></div>
        <div class="composer"><textarea id="tsText" placeholder="Ассаламу алейкум, есть отель в Мекке на 10 ночей?"></textarea><button class="btn primary" id="tsSend">Отправить</button></div>
      </div>
      <div class="side-info"><div class="card" id="tsInfo"><p class="muted">Здесь будет видно, что бот понял о клиенте.</p></div></div>
    </div>`;
  let waiting = false;
  const load = async () => {
    const d = await api('/api/test');
    const last = d.messages[d.messages.length - 1];
    waiting = !!last && last.dir === 'in';
    renderMessages(d.messages, $('#tsMsgs'), { typing: waiting });
    if (d.contact) {
      const r = d.request || {};
      const c = d.contact;
      $('#tsInfo').innerHTML = `<h3>Стадия</h3><p>${stageTag(c.stage)}</p>
        ${c.attention ? `<div class="note">🔔 Бот позвал бы вас: ${esc(c.attention_reason)}</div>` : ''}
        <h3 style="margin-top:10px">Что понял</h3><dl class="facts">${factRow('Город', CITY[r.city] || r.city)}${factRow('Отели', JSON.parse(r.hotels || '[]').join(', '))}${factRow('Даты', r.check_in ? `${fDate(r.check_in)} — ${fDate(r.check_out)}` : '')}${factRow('Ночей', r.nights)}${factRow('Гостей', r.guests)}${factRow('Номеров', r.rooms)}${factRow('Номер', r.room_type)}${factRow('Питание', r.meals)}${factRow('Бюджет', r.budget ? `${r.budget} ${r.currency || ''}` : '')}${factRow('Пожелания', r.notes)}</dl>
        ${c.summary ? `<h3>Кратко для вас</h3><p class="pre">${esc(c.summary)}</p>` : ''}`;
    }
  };
  await load();
  every(1500, () => { if (waiting) load(); });
  const send = async () => {
    const text = $('#tsText').value.trim(); if (!text) return;
    $('#tsText').value = '';
    await api('/api/test/send', { text });
    await load();
  };
  $('#tsSend').onclick = send;
  $('#tsText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#tsReset').onclick = async () => { await api('/api/test/reset', {}); route(); };
};

// ======================= ПОДКЛЮЧЕНИЯ =======================
PAGES.connect = async () => {
  const s = await api('/api/settings');
  await refreshOverview();
  const c = s.config, ch = OV.channels;
  const p = s.presets[c.ai.provider] || {};
  const sub = p.subscription;
  const pub = (c.panel.publicUrl || '').replace(/\/+$/, '');
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Подключения</h1></div></div>
    <div class="card" id="aiCard"><h2>🧠 ИИ</h2>
      <div class="form-grid">
        ${fieldHtml({ k: 'ai.provider', label: 'Чей ИИ', type: 'select', options: Object.entries(s.presets).map(([k, v]) => [k, v.name]) }, c)}
        ${fieldHtml({ k: 'ai.model', label: 'Модель для ответов клиентам', ph: p.model || 'по умолчанию', hint: c.ai.provider === 'claude-code' ? 'sonnet — быстро и умно; opus — умнее, но медленнее и тратит больше лимита; haiku — самая быстрая' : c.ai.provider === 'codex' ? 'Пусто — модель по умолчанию вашей подписки' : '' }, c)}
        ${fieldHtml({ k: 'ai.smartModel', label: 'Модель для разбора дня и аналитики', ph: p.smartModel || 'по умолчанию' }, c)}
      </div>
      ${sub ? '' : `<div class="form-grid">${fieldHtml({ k: 'ai.apiKey', label: 'Ключ API', type: 'password', hint: p.keyUrl ? `Взять ключ: <a href="${p.keyUrl}" target="_blank">${p.keyUrl}</a>` : '' }, c)}${fieldHtml({ k: 'ai.baseUrl', label: 'Адрес сервиса', ph: p.baseUrl || 'https://…/v1' }, c)}</div>`}
      ${c.ai.provider === 'claude-code' ? `<div class="note info"><b>Claude по подписке (Pro или Max).</b> Нужна программа Claude Code на этом компьютере и вход в ваш аккаунт Claude:
        <ol style="margin:6px 0 0"><li>Откройте ${s.platform === 'win32' ? 'PowerShell' : 'Терминал'} и вставьте: <code>${s.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'}</code></li>
        <li>Потом напишите <code>claude</code>, нажмите Enter и войдите в свой аккаунт Claude (откроется браузер).</li><li>Вернитесь сюда и нажмите «Проверить связь».</li></ol></div>` : ''}
      ${c.ai.provider === 'codex' ? `<div class="note info"><b>ChatGPT по подписке (Plus или Pro).</b> Нужна программа Codex и вход в ваш аккаунт ChatGPT:
        <ol style="margin:6px 0 0"><li>Откройте ${s.platform === 'win32' ? 'PowerShell' : 'Терминал'} и вставьте: <code>npm install -g @openai/codex</code></li>
        <li>Потом: <code>codex login</code> — войдите через ChatGPT.</li><li>Вернитесь сюда и нажмите «Проверить связь».</li></ol></div>` : ''}
      <details style="margin-top:10px"><summary class="muted">Дополнительно</summary><div class="form-grid" style="margin-top:8px">
        ${fieldHtml({ k: 'ai.claudePath', label: 'Путь к программе claude (если не находится сама)' }, c)}${fieldHtml({ k: 'ai.codexPath', label: 'Путь к программе codex' }, c)}
        ${fieldHtml({ k: 'ai.concurrency', label: 'Сколько клиентов обрабатывать одновременно', type: 'number' }, c)}
        ${fieldHtml({ k: 'ai.transcribeKey', label: 'Ключ OpenAI для расшифровки голосовых (по желанию)', type: 'password', hint: 'Без ключа бот видит, что пришло голосовое, но не слышит его. Расшифровка стоит копейки: около 0,6 цента за минуту.' }, c)}
      </div></details>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="aiSave">Сохранить</button><button class="btn" id="aiTest">Проверить связь</button><span id="aiRes"></span></div>
    </div>

    <div class="card"><h2>🟢 WhatsApp — по QR-коду <small class="muted">быстрый способ</small></h2>
      <p>${chState(ch.waqr)} ${ch.waqr?.me ? ` · номер +${esc(ch.waqr.me.id)}` : ''}</p>
      <div class="row top">
        <div class="qr" id="qrBox">${ch.waqr?.qr ? `<img src="${ch.waqr.qr}">` : ch.waqr?.state === 'connected' ? '✅' : ch.waqr?.state === 'connecting' ? '<span class="spin"></span>' : '—'}</div>
        <div class="grow" style="min-width:260px">
          <ol style="margin-top:0"><li>Нажмите «Подключить».</li><li>На телефоне: WhatsApp Business → ⋮ или Настройки → <b>Связанные устройства</b> → <b>Привязать устройство</b>.</li><li>Наведите камеру на код слева.</li></ol>
          <p class="muted small">Телефон работает как обычно: вы видите все ответы бота и можете ответить сами — тогда бот замолчит в этом чате на ${c.behavior.ownerPauseHours} ч.</p>
          <p class="small">📚 При подключении бот загрузит вашу переписку за последние ${c.study?.months || 12} мес. и изучит, как вы отвечаете клиентам${c.behavior.waitForStudy ? ' — пока изучает (обычно 5–20 минут), клиентам не отвечает' : ''}. Если телефон спросит, синхронизировать ли историю, — разрешите.</p>
          <div class="note">Это неофициальный способ (как WhatsApp Web через программу). WhatsApp может заблокировать номер за автоматизацию. Бот только отвечает на входящие и ничего не рассылает — это снижает риск, но не убирает его. Для полной безопасности — официальный способ ниже.</div>
          <div class="row" style="margin-top:10px">
            ${c.channels.waQr.enabled ? '<button class="btn" id="qrStop">Остановить</button><button class="btn danger" id="qrOut">Отвязать номер</button>' : '<button class="btn primary" id="qrStart">Подключить</button>'}
          </div>
        </div>
      </div>
    </div>

    <div class="card" id="pubCard"><h2>🌐 Адрес в интернете — для официального WhatsApp и Instagram</h2>
      <p class="muted">Meta присылает сообщения на адрес в интернете. Его даёт бесплатная программа ngrok (подробно — в файле <code>docs/ngrok.md</code>). Запустите <code>ngrok http ${c.panel.webhookPort} --url=ВАШ-АДРЕС.ngrok-free.app</code> и впишите адрес сюда.</p>
      ${OV.tunnel?.url ? `<p>${OV.tunnel.running && !OV.tunnel.error ? '<span class="dot on"></span> ngrok запущен Вакилем' : `<span class="dot bad"></span> ngrok: ${esc(OV.tunnel.error || 'не запущен')}`}</p>` : ''}
      <p class="muted small">Если адрес от ngrok и ngrok установлен — Вакиль сам запускает его вместе с собой.</p>
      <div class="row" style="align-items:flex-end"><div class="grow">${fieldHtml({ k: 'panel.publicUrl', label: 'Публичный адрес', ph: 'https://ваш-адрес.ngrok-free.app' }, c)}</div><button class="btn" id="pubSave" style="margin-bottom:10px">Сохранить</button></div>
    </div>

    <div class="card" id="wcCard"><h2>🟢 WhatsApp — официально (Meta Cloud API)</h2>
      <p>${chState(ch.wacloud)} · последнее сообщение от Meta: ${ago(ch.wacloud?.lastWebhookAt)} ${ch.wacloud?.error ? `<br><span class="err">${esc(ch.wacloud.error)}</span>` : ''}</p>
      ${fieldHtml({ k: 'channels.waCloud.enabled', label: 'Включить', type: 'check' }, c)}
      <div class="form-grid">
        ${fieldHtml({ k: 'channels.waCloud.phoneNumberId', label: 'Phone number ID' }, c)}
        ${fieldHtml({ k: 'channels.waCloud.token', label: 'Постоянный токен (System User)', type: 'password' }, c)}
        ${fieldHtml({ k: 'channels.waCloud.appSecret', label: 'App Secret (для проверки подписи)', type: 'password' }, c)}
        ${fieldHtml({ k: 'channels.waCloud.apiVersion', label: 'Версия API' }, c)}
      </div>
      <p class="small">В кабинете Meta → WhatsApp → Configuration → Webhook:<br>Callback URL: <code>${pub ? esc(pub) + '/webhook/whatsapp' : '(сначала впишите публичный адрес выше)'}</code><br>Verify token: <code>${esc(c.channels.waCloud.verifyToken)}</code><br>Подписаться на поля: <code>messages</code> (и <code>smb_message_echoes</code>, если номер работает и в приложении).</p>
      <p class="muted small">Пошагово — <code>docs/whatsapp-official.md</code>.</p>
      <button class="btn primary" data-save="wcCard">Сохранить</button>
    </div>

    <div class="card" id="igCard"><h2>🟣 Instagram</h2>
      <p>${chState(ch.instagram)} · последнее сообщение от Meta: ${ago(ch.instagram?.lastWebhookAt)} ${ch.instagram?.error ? `<br><span class="err">${esc(ch.instagram.error)}</span>` : ''}</p>
      ${fieldHtml({ k: 'channels.instagram.enabled', label: 'Включить', type: 'check' }, c)}
      <div class="form-grid">
        ${fieldHtml({ k: 'channels.instagram.igUserId', label: 'Instagram user ID (профессиональный аккаунт)' }, c)}
        ${fieldHtml({ k: 'channels.instagram.token', label: 'Токен доступа Instagram', type: 'password', hint: 'Продлевается сам раз в неделю, пока бот работает' }, c)}
        ${fieldHtml({ k: 'channels.instagram.appSecret', label: 'Instagram App Secret', type: 'password' }, c)}
        ${fieldHtml({ k: 'channels.instagram.apiVersion', label: 'Версия API' }, c)}
      </div>
      <p class="small">В кабинете Meta → Instagram → Webhooks:<br>Callback URL: <code>${pub ? esc(pub) + '/webhook/instagram' : '(сначала впишите публичный адрес выше)'}</code><br>Verify token: <code>${esc(c.channels.instagram.verifyToken)}</code><br>Подписаться на поле: <code>messages</code>.</p>
      <p class="muted small">Пошагово — <code>docs/instagram.md</code>.</p>
      <button class="btn primary" data-save="igCard">Сохранить</button>
    </div>

    <div class="card" id="ntCard"><h2>🔔 Уведомления вам</h2>
      <p class="muted">Когда клиент готов бронировать, сообщил об оплате или бот не знает ответа — Вакиль пишет вам.</p>
      ${fieldHtml({ k: 'business.ownerPhone', label: 'Ваш личный номер WhatsApp (с кодом страны, только цифры)', ph: '79991234567', hint: 'Не номер бота! Со своего номера вы также можете писать боту: «запомни…», «вот прайс…», «как дела за неделю?»' }, c)}
      ${fieldHtml({ k: 'notify.whatsappOwner', label: 'Присылать уведомления в WhatsApp', type: 'check' }, c)}
      <div class="form-grid">${fieldHtml({ k: 'notify.telegramToken', label: 'Telegram: токен бота (по желанию)', type: 'password', hint: 'Создать бота: @BotFather в Telegram' }, c)}${fieldHtml({ k: 'notify.telegramChatId', label: 'Telegram: ваш chat id', hint: 'Узнать: напишите боту @userinfobot' }, c)}</div>
      <button class="btn primary" data-save="ntCard">Сохранить</button>
    </div>`;
  const saveCard = (id) => async () => { await api('/api/settings', collect($('#' + id))); toast('Сохранено'); route(); };
  $('#aiSave').onclick = async () => {
    const patch = collect($('#aiCard'));
    const prevProvider = c.ai.provider;
    if (patch.ai.provider !== prevProvider) { const np = s.presets[patch.ai.provider]; patch.ai.model = np.model || ''; patch.ai.smartModel = np.smartModel || ''; patch.ai.baseUrl = ''; }
    await api('/api/settings', patch); toast('Сохранено'); route();
  };
  $('[data-k="ai.provider"]').onchange = $('#aiSave').onclick;
  $('#aiTest').onclick = () => busy($('#aiTest'), async () => {
    $('#aiRes').innerHTML = '<span class="muted">Жду ответ ИИ… (до минуты)</span>';
    const r = await api('/api/ai/test', {});
    $('#aiRes').innerHTML = r.ok ? `<span class="ok">✅ Работает: «${esc(r.text)}»</span>` : `<span class="err">❌ ${esc({ missing: 'Программа не установлена. ', auth: 'Не выполнен вход. ', limit: 'Кончился лимит подписки. ' }[r.code] || '')}${esc(r.message)}</span>`;
    refreshOverview();
  });
  $('#pubSave').onclick = saveCard('pubCard');
  $$('[data-save]').forEach((b) => (b.onclick = saveCard(b.dataset.save)));
  $('#qrStart') && ($('#qrStart').onclick = async () => { await api('/api/waqr/start', {}); toast('Запускаю… QR-код появится через несколько секунд'); setTimeout(PAGES.connect, 2500); });
  $('#qrStop') && ($('#qrStop').onclick = async () => { await api('/api/waqr/stop', {}); route(); });
  $('#qrOut') && ($('#qrOut').onclick = async () => { if (confirm('Отвязать WhatsApp от бота? Чтобы подключить снова, понадобится новый QR-код.')) { await api('/api/waqr/logout', {}); route(); } });
  if (c.channels.waQr.enabled && ch.waqr?.state !== 'connected') {
    every(2500, async () => {
      await refreshOverview();
      const w = OV.channels.waqr;
      if (w?.state === 'connected') return route();
      const box = $('#qrBox'); if (box && w?.qr) box.innerHTML = `<img src="${w.qr}">`;
    });
  }
};

// ======================= НАСТРОЙКИ =======================
PAGES.settings = async () => {
  const s = await api('/api/settings');
  const c = s.config;
  main.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Настройки</h1></div><button class="btn primary" id="stSave">Сохранить</button></div>
    <div class="grid c2" id="stForm">
      <div class="card"><h2>Компания</h2>
        ${fieldHtml({ k: 'business.name', label: 'Название компании', ph: 'Например: Умра-Тур' }, c)}
        ${fieldHtml({ k: 'business.agentName', label: 'Как зовут бота', hint: 'Так он представится, если спросят' }, c)}
        ${fieldHtml({ k: 'business.ownerName', label: 'Ваше имя' }, c)}
        ${fieldHtml({ k: 'business.ownerPhone', label: 'Ваш личный номер WhatsApp', ph: '79991234567' }, c)}
        ${fieldHtml({ k: 'business.about', label: 'О компании в двух словах', type: 'textarea', rows: 2 }, c)}
        <div class="form-grid">
          ${fieldHtml({ k: 'business.currency', label: 'Основная валюта' }, c)}
          ${fieldHtml({ k: 'business.timezone', label: 'Часовой пояс', type: 'select', options: [['Asia/Riyadh', 'Мекка (UTC+3)'], ['Europe/Moscow', 'Москва (UTC+3)'], ['Europe/Istanbul', 'Стамбул (UTC+3)'], ['Asia/Almaty', 'Алматы (UTC+5)'], ['Asia/Tashkent', 'Ташкент (UTC+5)'], ['Asia/Dubai', 'Дубай (UTC+4)'], ['Europe/London', 'Лондон'], ['Europe/Berlin', 'Берлин'], ['UTC', 'UTC']] }, c)}
        </div>
        ${fieldHtml({ k: 'business.workHours', label: 'Когда вы на связи', ph: 'ежедневно 9:00–23:00 по Мекке', hint: 'Бот скажет клиенту, когда ждать ответа человека' }, c)}
      </div>
      <div class="card"><h2>Как отвечает бот</h2>
        ${fieldHtml({ k: 'behavior.botEnabled', label: 'Бот отвечает клиентам', type: 'check' }, c)}
        ${fieldHtml({ k: 'behavior.pricing', label: 'Цены', type: 'select', options: [['list', 'Называть цены из прайса, если они актуальны'], ['owner', 'Цены называю только я — бот собирает запрос и зовёт меня']] }, c)}
        ${fieldHtml({ k: 'behavior.style', label: 'Стиль общения', type: 'textarea', rows: 3 }, c)}
        ${fieldHtml({ k: 'behavior.fallbackText', label: 'Если ИИ недоступен, клиенту уйдёт', type: 'textarea', rows: 2, hint: 'Один раз, и вам сразу придёт уведомление. Пусто — ничего не отправлять.' }, c)}
        <div class="form-grid">
          ${fieldHtml({ k: 'behavior.debounceSec', label: 'Ждать, пока клиент допишет (сек)', type: 'number' }, c)}
          ${fieldHtml({ k: 'behavior.ownerPauseHours', label: 'Молчать после вашего ответа (часов)', type: 'number' }, c)}
          ${fieldHtml({ k: 'behavior.answerOldHours', label: 'Отвечать на пропущенные не старше (часов)', type: 'number', hint: 'Пока компьютер был выключен' }, c)}
          ${fieldHtml({ k: 'behavior.maxReplyChars', label: 'Длина ответа не больше (знаков)', type: 'number' }, c)}
        </div>
        ${fieldHtml({ k: 'behavior.humanDelay', label: 'Показывать «печатает…» и отвечать с небольшой паузой', type: 'check' }, c)}
      </div>
      <div class="card"><h2>Самообучение и отчёты</h2>
        <div class="form-grid">${fieldHtml({ k: 'schedule.reviewHour', label: 'Во сколько разбирать день (час, 0–23)', type: 'number' }, c)}</div>
        ${fieldHtml({ k: 'behavior.autoApproveLessons', label: 'Применять уроки из разбора дня сразу, без моего одобрения', type: 'check', hint: 'Удобно, но бот может выучить лишнее. Рекомендуем сначала одобрять вручную.' }, c)}
        ${fieldHtml({ k: 'schedule.weeklyReport', label: 'Присылать отчёт за неделю по понедельникам', type: 'check' }, c)}
        ${fieldHtml({ k: 'study.weekly', label: 'Раз в неделю доизучать мои новые ответы клиентам и уточнять мой стиль', type: 'check' }, c)}
        ${fieldHtml({ k: 'behavior.waitForStudy', label: 'Пока бот изучает мою переписку — не отвечать клиентам (не дольше 30 минут)', type: 'check' }, c)}
        <div class="form-grid">${fieldHtml({ k: 'study.months', label: 'Изучать переписку за последние (месяцев)', type: 'number' }, c)}</div>
        ${fieldHtml({ k: 'study.importHistory', label: 'Загружать историю чатов при подключении WhatsApp по QR-коду', type: 'check' }, c)}
      </div>
      <div class="card"><h2>Панель</h2>
        ${fieldHtml({ k: 'panel.preventSleep', label: 'Не давать Mac засыпать, пока работает бот', type: 'check', hint: 'На Windows: Параметры → Система → Питание → «Переводить в спящий режим: Никогда»' }, c)}
        ${fieldHtml({ k: 'panel.allowLan', label: 'Открывать панель с телефона в той же Wi-Fi сети', type: 'check', hint: `Нужен пароль. После сохранения перезапустите Вакиль. Адрес: ${s.lan.map((a) => `http://${a}:${c.panel.port}`).join(' или ') || '—'}` }, c)}
        ${fieldHtml({ k: 'panel.password', label: 'Пароль панели', type: 'password' }, c)}
        <p class="muted small">Порты: панель ${c.panel.port}, вебхуки ${c.panel.webhookPort}. Меняются в файле data/config.json.</p>
      </div>
    </div>`;
  $('#stSave').onclick = () => busy($('#stSave'), async () => { await api('/api/settings', collect($('#stForm'))); toast('Сохранено'); refreshOverview(); });
};

// ---------- старт ----------
if (document.body.dataset.login) showLogin();
else {
  refreshOverview().then(route);
  setInterval(refreshOverview, 10000);
}
