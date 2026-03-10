/**
 * debug-log.js — Debug & Error Logger
 * Пишет логи в файл logs/debug.log и выводит в консоль с цветами
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');
const ERR_FILE = path.join(LOG_DIR, 'error.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB — потом ротируется

// Создаём папку если нет
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Цвета для консоли ────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  blue:   '\x1b[34m',
};

// ── Уровни логов ─────────────────────────────────────────────────────
const LEVELS = {
  INFO:    { color: C.cyan,    icon: '◆', file: LOG_FILE },
  SUCCESS: { color: C.green,   icon: '✓', file: LOG_FILE },
  WARN:    { color: C.yellow,  icon: '⚠', file: LOG_FILE },
  ERROR:   { color: C.red,     icon: '✗', file: ERR_FILE },
  REQUEST: { color: C.magenta, icon: '→', file: LOG_FILE },
  PROXY:   { color: C.blue,    icon: '⇄', file: LOG_FILE },
  AUTH:    { color: C.green,   icon: '🔑', file: LOG_FILE },
  DB:      { color: C.dim,     icon: '·', file: LOG_FILE },
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function write(file, line) {
  try {
    // Ротация если файл > 5MB
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > MAX_SIZE) {
        fs.renameSync(file, file + '.old');
      }
    }
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch {}
}

function log(level, message, meta) {
  const lvl   = LEVELS[level] || LEVELS.INFO;
  const ts    = timestamp();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';

  // Консоль
  const consoleStr = `${C.dim}${ts}${C.reset} ${lvl.color}${lvl.icon} ${level.padEnd(7)}${C.reset} ${message}${C.dim}${metaStr}${C.reset}`;
  console.log(consoleStr);

  // Файл (без цветов)
  const fileStr = `[${ts}] ${level.padEnd(7)} ${lvl.icon} ${message}${metaStr}`;
  write(lvl.file, fileStr);

  // Ошибки пишем в оба файла
  if (level === 'ERROR') {
    write(LOG_FILE, fileStr);
  }
}

// ── Публичный API ────────────────────────────────────────────────────
const logger = {
  info:    (msg, meta) => log('INFO',    msg, meta),
  success: (msg, meta) => log('SUCCESS', msg, meta),
  warn:    (msg, meta) => log('WARN',    msg, meta),
  error:   (msg, meta) => log('ERROR',   msg, meta),
  request: (msg, meta) => log('REQUEST', msg, meta),
  proxy:   (msg, meta) => log('PROXY',   msg, meta),
  auth:    (msg, meta) => log('AUTH',    msg, meta),
  db:      (msg, meta) => log('DB',      msg, meta),

  // Middleware Express — логирует все HTTP запросы
  middleware() {
    return (req, res, next) => {
      const start = Date.now();
      const { method, url, ip } = req;

      res.on('finish', () => {
        const ms     = Date.now() - start;
        const status = res.statusCode;
        const color  = status >= 500 ? C.red : status >= 400 ? C.yellow : C.green;
        const ts     = timestamp();

        const consoleStr = `${C.dim}${ts}${C.reset} ${C.magenta}→ REQUEST${C.reset} ${C.bold}${method.padEnd(6)}${C.reset} ${url.padEnd(30)} ${color}${status}${C.reset} ${C.dim}${ms}ms${C.reset}`;
        console.log(consoleStr);

        const fileStr = `[${ts}] REQUEST  → ${method.padEnd(6)} ${url.padEnd(30)} ${status} ${ms}ms`;
        write(LOG_FILE, fileStr);

        // Логируем ошибки 4xx/5xx в error.log
        if (status >= 400) {
          write(ERR_FILE, `[${ts}] HTTP_${status}  → ${method} ${url} (${ms}ms)`);
        }
      });

      next();
    };
  },

  // Читает последние N строк из лог файла
  tail(n = 50, type = 'all') {
    const file = type === 'error' ? ERR_FILE : LOG_FILE;
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  },

  // Очищает логи
  clear() {
    try { fs.writeFileSync(LOG_FILE, ''); } catch {}
    try { fs.writeFileSync(ERR_FILE, ''); } catch {}
    log('INFO', 'Logs cleared');
  },

  // Путь к файлам
  paths: { log: LOG_FILE, error: ERR_FILE, dir: LOG_DIR },
};

module.exports = logger;
