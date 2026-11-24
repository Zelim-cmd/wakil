// Настройки Вакиля: data/config.json. Всё, что владелец меняет в панели «Настройки» и «Подключения».
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(process.env.WAKIL_DATA || path.join(ROOT, 'data'));
export const paths = {
  config: path.join(DATA, 'config.json'),
  db: path.join(DATA, 'wakil.db'),
  knowledge: path.join(DATA, 'knowledge'),
  media: path.join(DATA, 'media'),
  waAuth: path.join(DATA, 'whatsapp-auth'),
  aiWork: path.join(DATA, 'ai-work'),
  models: path.join(DATA, 'models'),
  log: path.join(DATA, 'wakil.log'),
};

const rand = () => crypto.randomBytes(12).toString('hex');

export function defaults() {
  return {
    business: {
      name: '',                 // название компании, как его называть клиентам
      agentName: 'Вакиль',      // как бот представляется
      ownerName: '',
      ownerPhone: '',           // личный номер владельца (для уведомлений и команд), только цифры с кодом страны
      about: '',                // пара строк о компании
      currency: 'SAR',
      timezone: 'Asia/Riyadh',
      workHours: '',            // например: «ежедневно 9:00–23:00 по Мекке»
    },
    behavior: {
      botEnabled: true,
      pricing: 'list',          // list — называть цены из прайса, если он свежий; owner — цены называет только человек
      debounceSec: 10,          // ждать столько секунд после последнего сообщения клиента (клиенты пишут несколькими сообщениями)
      ownerPauseHours: 12,      // если владелец ответил сам — бот молчит в этом чате столько часов
      answerOldHours: 12,       // отвечать на сообщения, пришедшие пока компьютер был выключен, не старше стольких часов
      maxReplyChars: 1200,
      humanDelay: true,         // «печатает…» и небольшая пауза перед ответом
      fallbackText: 'Спасибо за сообщение! Менеджер ответит вам в ближайшее время.',
      autoApproveLessons: false,// уроки из ежедневного разбора применять без одобрения владельца
      waitForStudy: true,       // пока бот изучает переписку владельца — не отвечать клиентам (не дольше 30 минут)
      style: 'Вежливо, тепло и коротко, как опытный менеджер. Без канцелярита. Уважительно к паломникам.',
    },
    ai: {
      provider: 'claude-code',  // claude-code | codex | anthropic | openai | gemini | openrouter | deepseek | custom
      model: 'sonnet',          // для ответов клиентам
      smartModel: 'opus',       // для ежедневного разбора и аналитики
      apiKey: '',
      baseUrl: '',
      claudePath: '',           // путь к claude, если его не видно (обычно не нужен)
      codexPath: '',
      concurrency: 2,
    },
    channels: {
      waQr: { enabled: false },
      waCloud: { enabled: false, phoneNumberId: '', token: '', appSecret: '', verifyToken: rand(), apiVersion: 'v23.0' },
      instagram: { enabled: false, igUserId: '', token: '', appSecret: '', verifyToken: rand(), apiVersion: 'v23.0', tokenRefreshedAt: 0 },
    },
    notify: { whatsappOwner: false },   // дублировать уведомления на личный WhatsApp (с номера бота)
    telegram: { token: '', ownerChatId: '', ownerName: '', botUsername: '', bindCode: crypto.randomBytes(5).toString('hex') },
    voice: { engine: 'local', model: 'onnx-community/whisper-small', apiKey: '',
      languages: ['ru', 'ar', 'en', 'tr', 'kk', 'uz', 'ky', 'tt', 'az', 'tg', 'fr', 'de', 'id', 'ms', 'ur', 'fa', 'uk'] },
    panel: { port: 8790, webhookPort: 8791, allowLan: false, password: '', preventSleep: true, publicUrl: '', autoTunnel: true },
    schedule: { reviewHour: 23, weeklyReport: true },
    study: { months: 12, maxChars: 300000, importHistory: true, weekly: true },
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

let current = null;
const listeners = new Set();

export function loadConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch {}
  current = merge(defaults(), saved);
  if (!fs.existsSync(paths.config)) saveConfig(current);
  return current;
}

export function config() { return current || loadConfig(); }

export function saveConfig(next) {
  current = next;
  const tmp = paths.config + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, paths.config);
  for (const fn of listeners) { try { fn(next); } catch {} }
}

/** Изменить часть настроек: patch({ behavior: { debounceSec: 5 } }). */
export function patchConfig(patch) { saveConfig(merge(config(), patch)); return config(); }
export function onConfigChange(fn) { listeners.add(fn); }

// Секреты в панель не отдаём: только «задан / не задан» и последние 4 знака.
const SECRET = /^(token|apiKey|appSecret|password)$/;
export function publicConfig(c = config()) {
  const walk = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (SECRET.test(k)) out[k] = v ? '••••' + String(v).slice(-4) : '';
      else out[k] = walk(v);
    }
    return out;
  };
  return walk(c);
}
/** Обратное: значения «••••1234» из панели означают «оставить как было». */
export function stripMasked(patch) {
  const walk = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (SECRET.test(k) && typeof v === 'string' && v.startsWith('••••')) continue;
      out[k] = walk(v);
    }
    return out;
  };
  return walk(patch);
}

export function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  try { fs.appendFileSync(paths.log, line + '\n'); } catch {}
}
