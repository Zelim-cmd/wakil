// Подключение ИИ. Один вход — ask(): Вакилю всё равно, кто отвечает.
//  claude-code — Claude по подписке (Pro/Max) через установленный Claude Code, без ключа;
//  codex       — ChatGPT по подписке (Plus/Pro) через установленный Codex CLI, без ключа;
//  anthropic   — Claude по ключу API;
//  openai, gemini, openrouter, deepseek, custom — любой сервис, совместимый с OpenAI, по ключу.
// Сообщения клиентов — чужой текст. Поэтому ИИ запускается без инструментов: он не может
// читать файлы, выполнять команды или ходить в интернет — только написать ответ.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config, paths, log } from '../config.mjs';
import { insert } from '../db.mjs';

export const PRESETS = {
  'claude-code': { name: 'Claude — по подписке (Claude Code)', model: 'sonnet', smartModel: 'opus', subscription: true },
  codex: { name: 'ChatGPT — по подписке (Codex)', model: '', smartModel: '', subscription: true },
  anthropic: { name: 'Claude — по ключу API', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', smartModel: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai: { name: 'OpenAI — по ключу API', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', smartModel: 'gpt-5', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { name: 'Google Gemini — по ключу', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', smartModel: 'gemini-2.5-pro', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { name: 'OpenRouter — по ключу', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', smartModel: 'anthropic/claude-opus-4.1', keyUrl: 'https://openrouter.ai/keys' },
  deepseek: { name: 'DeepSeek — по ключу', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', smartModel: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  custom: { name: 'Другой сервис, совместимый с OpenAI', baseUrl: '', model: '', smartModel: '' },
};

// ---------- очередь: одновременно не больше N запросов к ИИ ----------
let running = 0;
const waiting = [];
async function slot(fn) {
  const limit = Math.max(1, Number(config().ai.concurrency) || 2);
  if (running >= limit) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; const next = waiting.shift(); if (next) next(); }
}

/** Для проверок: подменить ИИ своим обработчиком ({system, prompt, schema, images, model}) → {ok, data|text}. */
let mock = null;
export function setMockAi(fn) { mock = fn; }

/**
 * Спросить ИИ.
 * @param {{purpose:string, system:string, prompt:string, schema?:object, images?:{path:string,mime:string}[], smart?:boolean, timeoutMs?:number}} o
 * @returns {Promise<{ok:true, data?:any, text:string} | {ok:false, code:string, message:string}>}
 *   code: auth (не вошли / неверный ключ) | limit (кончился лимит подписки) | missing (программа не установлена) | timeout | format | error
 */
export async function ask(o) {
  const cfg = config().ai;
  const provider = mock ? 'mock' : cfg.provider;
  const preset = PRESETS[provider] || {};
  const model = (o.smart ? cfg.smartModel || cfg.model : cfg.model) || (o.smart ? preset.smartModel : preset.model) || '';
  const started = Date.now();
  const res = await slot(async () => {
    try {
      let r;
      if (mock) r = await mock({ ...o, model });
      else if (provider === 'claude-code') r = await runClaude({ ...o, model });
      else if (provider === 'codex') r = await runCodex({ ...o, model });
      else if (provider === 'anthropic') r = await runAnthropic({ ...o, model, cfg, preset });
      else r = await runOpenAI({ ...o, model, cfg, preset });
      if (r.ok && o.schema && r.data === undefined) {
        const data = parseJson(r.text);
        if (data === undefined) return { ok: false, code: 'format', message: 'ИИ ответил не в том формате: ' + String(r.text).slice(0, 200) };
        r.data = data;
      }
      return r;
    } catch (e) {
      return { ok: false, code: 'error', message: e.message || String(e) };
    }
  });
  try {
    insert('ai_calls', { at: started, purpose: o.purpose || '', provider, model, ms: Date.now() - started, ok: res.ok ? 1 : 0, error: res.ok ? '' : `${res.code}: ${res.message}`.slice(0, 500) });
  } catch {}
  if (!res.ok) log('ИИ ошибка', o.purpose, res.code, res.message);
  return res;
}

/** Достаём JSON из ответа, даже если ИИ обернул его в ```json … ``` или добавил слова. */
export function parseJson(text) {
  if (text == null) return undefined;
  if (typeof text === 'object') return text;
  const s = String(text).trim();
  try { return JSON.parse(s); } catch {}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return undefined;
}

const schemaHint = (schema) =>
  `\n\nОТВЕТ: верни только JSON-объект без пояснений и без \`\`\`, строго по этой схеме:\n${JSON.stringify(schema)}`;

// ---------- поиск программ ----------
function findBin(name, explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = os.homedir();
  const win = process.platform === 'win32';
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin',
    win ? path.join(process.env.APPDATA || '', 'npm') : '',
  ].filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

/** Запуск программы; на Windows .cmd-файлы запускаются через оболочку (аргументы при этом в кавычках). */
function runProcess(bin, args, { input, timeoutMs, env, cwd }) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const q = (a) => `"${String(a).replace(/"/g, '\\"')}"`;
    let child;
    try {
      child = shell
        ? spawn(q(bin), args.map(q), { shell: true, env, cwd, windowsHide: true })
        : spawn(bin, args, { env, cwd, windowsHide: true });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message, spawnError: e }); }
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGTERM'); } catch {} finish(-2); } }, timeoutMs);
    const finish = (code, spawnError) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, spawnError }); };
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(-1, e));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

function classify(text) {
  const t = String(text || '');
  if (/usage limit|rate.?limit|limit reached|out of (extra )?usage|quota|429|too many requests|лимит/i.test(t)) return 'limit';
  if (/not logged in|please run \/login|login|invalid api key|unauthori[sz]ed|401|authentication|auth/i.test(t)) return 'auth';
  return 'error';
}

function workDir() { fs.mkdirSync(paths.aiWork, { recursive: true }); return paths.aiWork; }
const tmpName = (ext) => path.join(workDir(), `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);

// ---------- Claude Code (подписка) ----------
const CLAUDE_OPTIONAL = ['--setting-sources', '--strict-mcp-config', '--permission-prompts', '--disable-slash-commands', '--no-session-persistence'];

async function runClaude({ system, prompt, schema, images = [], model, timeoutMs = 240000 }) {
  const bin = findBin('claude', config().ai.claudePath);
  if (!bin) return { ok: false, code: 'missing', message: 'Claude Code не найден. Установите его и войдите в свой аккаунт (см. инструкцию в README).' };
  const sysFile = tmpName('.txt');
  fs.writeFileSync(sysFile, system);
  const content = [];
  for (const img of images) {
    try { content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/jpeg', data: fs.readFileSync(img.path).toString('base64') } }); } catch {}
  }
  content.push({ type: 'text', text: prompt });
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const env = { ...process.env };
  // только подписка: ключи API и следы родительской сессии Claude Code не передаём
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  const build = (minimal) => {
    const a = ['-p'];
    if (model) a.push('--model', model);
    if (!minimal) a.push('--setting-sources', '', '--strict-mcp-config', '--permission-prompts', 'none', '--disable-slash-commands', '--no-session-persistence');
    a.push('--tools', '', '--system-prompt-file', sysFile, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
    // на Windows через оболочку JSON-схему в аргументе не передать — тогда просим формат словами
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (schema && !shell) a.push('--json-schema', JSON.stringify(schema));
    return a;
  };
  try {
    let r = await runProcess(bin, build(false), { input, timeoutMs, env, cwd: workDir() });
    if (/unknown option|unrecognized|unexpected argument/i.test(r.stderr) && CLAUDE_OPTIONAL.some((f) => r.stderr.includes(f))) {
      r = await runProcess(bin, build(true), { input, timeoutMs, env, cwd: workDir() });
    }
    if (r.code === -2) return { ok: false, code: 'timeout', message: 'Claude долго не отвечал' };
    if (r.spawnError) return { ok: false, code: 'missing', message: r.spawnError.message };
    let result = null;
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.type === 'result') result = m; } catch {}
    }
    if (!result) return { ok: false, code: classify(r.stderr + r.stdout), message: (r.stderr || r.stdout || 'нет ответа').slice(-500) };
    if (result.is_error || result.subtype !== 'success') {
      const msg = String(result.result || result.subtype || 'ошибка');
      return { ok: false, code: result.api_error_status === 429 ? 'limit' : classify(msg), message: msg.slice(0, 500) };
    }
    const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
    return { ok: true, text, data: schema ? (result.structured_output ?? parseJson(text)) : undefined };
  } finally {
    fs.rm(sysFile, { force: true }, () => {});
  }
}

// ---------- Codex (подписка ChatGPT) ----------
// Отключаем у Codex всё, кроме ответа текстом: команды, браузер, плагины, поиск.
const CODEX_OFF = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'multi_agent', 'plugins', 'remote_plugin', 'skill_search', 'tool_suggest', 'code_mode_host', 'in_app_browser', 'hooks', 'goals', 'shell_snapshot'];

async function runCodex({ system, prompt, schema, images = [], model, timeoutMs = 300000 }) {
  const bin = findBin('codex', config().ai.codexPath);
  if (!bin) return { ok: false, code: 'missing', message: 'Codex не найден. Установите его и войдите через свой аккаунт ChatGPT (см. README).' };
  const out = tmpName('.out.txt');
  const schemaFile = schema ? tmpName('.schema.json') : null;
  if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(schema)));
  const build = (off) => {
    const a = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-rules', '--ignore-user-config', '--color', 'never', '-C', workDir()];
    for (const f of off) a.push('--disable', f);
    a.push('-c', 'web_search="disabled"');
    if (model) a.push('-m', model);
    if (schemaFile) a.push('--output-schema', schemaFile);
    for (const img of images) a.push('-i', img.path);
    a.push('-o', out, '-');
    return a;
  };
  const input = `${system}\n\nУ тебя нет инструментов: ничего не выполняй и не читай файлы, только напиши ответ.\n\n=====\n\n${prompt}`;
  try {
    let r = await runProcess(bin, build(CODEX_OFF), { input, timeoutMs, cwd: workDir(), env: process.env });
    // старая или новая версия Codex может не знать часть названий — тогда отключаем только главное
    if (r.code !== 0 && /unknown feature|invalid value|unrecognized|not a valid feature/i.test(r.stderr)) {
      r = await runProcess(bin, build(['shell_tool', 'unified_exec']), { input, timeoutMs, cwd: workDir(), env: process.env });
    }
    if (r.code === -2) return { ok: false, code: 'timeout', message: 'ChatGPT долго не отвечал' };
    if (r.spawnError) return { ok: false, code: 'missing', message: r.spawnError.message };
    let text = '';
    try { text = fs.readFileSync(out, 'utf8').trim(); } catch {}
    if (r.code !== 0 || !text) {
      const err = (r.stderr + '\n' + r.stdout).split('\n').filter((l) => /error|limit|login|auth/i.test(l)).slice(-3).join(' ') || r.stderr.slice(-400);
      return { ok: false, code: classify(err), message: err.slice(0, 500) || 'нет ответа' };
    }
    return { ok: true, text };
  } finally {
    fs.rm(out, { force: true }, () => {});
    if (schemaFile) fs.rm(schemaFile, { force: true }, () => {});
  }
}

/** Схема для строгого режима OpenAI/Codex: у каждого объекта все поля обязательны и лишних нет. */
export function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (!s || typeof s !== 'object') return s;
  const o = { ...s };
  if (o.properties) {
    o.properties = Object.fromEntries(Object.entries(o.properties).map(([k, v]) => [k, strictSchema(v)]));
    o.required = Object.keys(o.properties);
    o.additionalProperties = false;
  }
  if (o.items) o.items = strictSchema(o.items);
  return o;
}

// ---------- по ключу API ----------
async function fetchJson(url, opts, timeoutMs) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const body = await r.text();
  if (!r.ok) {
    const code = r.status === 401 || r.status === 403 ? 'auth' : r.status === 429 || /quota|credit|insufficient/i.test(body) ? 'limit' : 'error';
    const e = new Error(`${r.status}: ${body.slice(0, 400)}`); e.code = code; e.status = r.status; e.body = body; throw e;
  }
  return JSON.parse(body);
}

async function runAnthropic({ system, prompt, schema, images = [], model, cfg, preset, timeoutMs = 180000 }) {
  if (!cfg.apiKey) return { ok: false, code: 'auth', message: 'Нет ключа API' };
  const content = [];
  for (const img of images) {
    try { content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/jpeg', data: fs.readFileSync(img.path).toString('base64') } }); } catch {}
  }
  content.push({ type: 'text', text: prompt + (schema ? schemaHint(schema) : '') });
  try {
    const j = await fetchJson(`${(cfg.baseUrl || preset.baseUrl).replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content }] }),
    }, timeoutMs);
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { ok: true, text };
  } catch (e) {
    return { ok: false, code: e.name === 'TimeoutError' ? 'timeout' : e.code || 'error', message: e.message };
  }
}

async function runOpenAI({ system, prompt, schema, images = [], model, cfg, preset, timeoutMs = 180000 }) {
  const base = (cfg.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, code: 'error', message: 'Не указан адрес сервиса' };
  if (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(base)) return { ok: false, code: 'auth', message: 'Нет ключа API' };
  const parts = [];
  for (const img of images) {
    try { parts.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/jpeg'};base64,${fs.readFileSync(img.path).toString('base64')}` } }); } catch {}
  }
  parts.push({ type: 'text', text: prompt + (schema ? schemaHint(schema) : '') });
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? parts : parts[parts.length - 1].text }] };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
  try {
    let j;
    try {
      j = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(schema ? { ...body, response_format: { type: 'json_object' } } : body) }, timeoutMs);
    } catch (e) {
      if (!(schema && e.status === 400 && /response_format|json/i.test(e.body || ''))) throw e;
      j = await fetchJson(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
    }
    return { ok: true, text: j.choices?.[0]?.message?.content || '' };
  } catch (e) {
    return { ok: false, code: e.name === 'TimeoutError' ? 'timeout' : e.code || 'error', message: e.message };
  }
}

/** Расшифровка голосового сообщения (по желанию, нужен ключ OpenAI). Возвращает текст или ''. */
export async function transcribe(filePath, mime) {
  const key = config().ai.transcribeKey;
  if (!key) return '';
  try {
    const fd = new FormData();
    fd.append('model', 'whisper-1');
    fd.append('file', new Blob([fs.readFileSync(filePath)], { type: mime || 'audio/ogg' }), path.basename(filePath));
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(120000) });
    if (!r.ok) { log('Расшифровка голосового:', r.status, (await r.text()).slice(0, 200)); return ''; }
    return String((await r.json()).text || '').trim();
  } catch (e) { log('Расшифровка голосового:', e.message); return ''; }
}

/** Проверка подключения из панели. */
export async function testAi() {
  const r = await ask({
    purpose: 'test', system: 'Ты проверка связи.', prompt: 'Ответь JSON: {"ok": true, "hello": "<приветствие на русском, 3 слова>"}',
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, hello: { type: 'string' } }, required: ['ok', 'hello'] },
    timeoutMs: 120000,
  });
  return r.ok ? { ok: true, text: r.data?.hello || r.text } : r;
}
