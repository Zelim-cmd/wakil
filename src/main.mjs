// Вакиль — запуск: база, каналы, панель, расписание (разбор дня, недельный отчёт).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`\nНужен Node.js версии 22.13 или новее (сейчас ${process.versions.node}).\nСкачайте «LTS» с https://nodejs.org и запустите снова.\n`);
  process.exit(1);
}

const { loadConfig, config, onConfigChange, paths, log } = await import('./config.mjs');
const { openDb, closeDb, kvGet, kvSet } = await import('./db.mjs');
const { ensureKnowledge } = await import('./knowledge.mjs');
const hub = await import('./channels/hub.mjs');
const { handleInbound } = await import('./agent.mjs');
const { startServers } = await import('./web.mjs');
const { dailyReview } = await import('./learning.mjs');
const { weeklyRestudy } = await import('./study.mjs');
const { summaryText } = await import('./analytics.mjs');
const { notifyOwner } = await import('./notify.mjs');
const { waCloudAdapter, instagramAdapter, refreshInstagramToken } = await import('./channels/meta.mjs');
const tunnel = await import('./tunnel.mjs');
const telegram = await import('./telegram.mjs');
const { preloadVoice } = await import('./voice.mjs');
const { resumeDocuments } = await import('./documents.mjs');

loadConfig();
openDb(paths.db);
ensureKnowledge();

// ---------- каналы ----------
hub.onInbound(handleInbound);
hub.register('test', { send: async () => ({ ok: true, extId: 'bot' + Date.now() + Math.random().toString(36).slice(2, 6) }), status: () => ({ state: 'connected' }) });
hub.register('wacloud', waCloudAdapter);
hub.register('instagram', instagramAdapter);

let waqr = null;
async function syncWaQr() {
  const want = !!config().channels.waQr.enabled;
  if (want && !waqr) {
    try {
      waqr = await import('./channels/wa-qr.mjs');
      hub.register('waqr', waqr.adapter);
      await waqr.start();
    } catch (e) { log('WhatsApp (QR) не запустился:', e); }
  } else if (want && waqr && waqr.adapter.status().state === 'off') {
    hub.register('waqr', waqr.adapter);
    await waqr.start().catch((e) => log('WhatsApp (QR):', e));
  } else if (!want && waqr) {
    await waqr.stop();
  }
}
await syncWaQr();
onConfigChange(() => { syncWaQr(); tunnel.syncTunnel(); telegram.syncTelegram().catch((e) => log('Telegram:', e)); });
if (!config().channels.waQr.enabled) {
  // чтобы панель показывала «выключен», даже пока модуль не загружен
  hub.register('waqr', { send: async () => ({ ok: false, error: 'WhatsApp (QR) выключен' }), status: () => ({ state: 'off' }) });
}

startServers();
tunnel.syncTunnel();
telegram.syncTelegram().catch((e) => log('Telegram:', e));
// модель распознавания голосовых загружаем заранее, чтобы первое голосовое клиента не ждало
setTimeout(preloadVoice, 5000);
// документы, которые не успели разобрать до перезапуска, — дочитываем
setTimeout(resumeDocuments, 8000);

// ---------- Mac не засыпает, пока Вакиль работает (иначе бот не ответит) ----------
if (process.platform === 'darwin' && config().panel.preventSleep) {
  try { spawn('caffeinate', ['-is', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

// ---------- расписание ----------
function localNow() {
  const tz = config().business.timezone || 'Asia/Riyadh';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const t = localNow();
    const sch = config().schedule;
    if (t.hour === Number(sch.reviewHour ?? 23) && kvGet('review_day') !== t.day) {
      kvSet('review_day', t.day);
      log('Ежедневный разбор…');
      const r = await dailyReview();
      log('Разбор:', r.ok ? (r.skipped ? 'переписки не было' : `предложено уроков: ${r.proposals}`) : r.message);
      // раз в неделю — доизучить, как владелец отвечал сам, и уточнить его стиль
      await weeklyRestudy();
    }
    if (sch.weeklyReport && t.weekday === 'Mon' && t.hour === 9 && kvGet('weekly_day') !== t.day) {
      kvSet('weekly_day', t.day);
      await notifyOwner('report', `📊 Неделя в цифрах\n${summaryText(7)}`);
    }
    await refreshInstagramToken();
    // временные файлы ИИ старше суток
    try {
      for (const f of fs.readdirSync(paths.aiWork)) {
        const p = path.join(paths.aiWork, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true, recursive: true });
      }
    } catch {}
  } catch (e) { log('Расписание:', e); } finally { ticking = false; }
}
setInterval(tick, 60000);
setTimeout(tick, 15000);

// ---------- аккуратное завершение ----------
async function shutdown() {
  log('Вакиль останавливается…');
  try { await waqr?.stop(); } catch {}
  try { tunnel.stop(); } catch {}
  try { telegram.stopTelegram(); } catch {}
  try { closeDb(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log('Необработанная ошибка:', e));

const c = config();
log(`Вакиль запущен. ИИ: ${c.ai.provider}. Панель: http://localhost:${c.panel.port}`);
