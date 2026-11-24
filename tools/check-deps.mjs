// Все ли библиотеки на месте? После обновления (git pull) могли добавиться новые — тогда лаунчер запустит npm install.
// Код выхода 1 — чего-то не хватает.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const missing = Object.keys(pkg.dependencies || {}).filter((n) => !fs.existsSync(path.join(root, 'node_modules', n, 'package.json')));
if (missing.length) {
  console.log('Не хватает библиотек:', missing.join(', '));
  process.exit(1);
}
