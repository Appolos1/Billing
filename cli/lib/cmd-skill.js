// cmd-skill.js — Система прокачки навыков
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { clr, getToken, getServerUrl, isLoggedIn, apiRequest } = require('./config');

const SKILL_FILE = path.join(process.cwd(), 'SKILL.md');
const HISTORY_FILE = path.join(os.homedir(), '.billing', 'skill-history.json');

module.exports = function(program) {
  const skill = program.command('skill').description('🌱 Skill system — upgrade your AI assistant');

  // billing skill  →  show current level
  skill
    .command('status')
    .alias('show')
    .description('Show current skill level')
    .action(() => {
      const data = readSkillFile();
      const stats = parseStats(data);
      printSkillCard(stats);
    });

  // billing skill upgrade  →  AI upgrades SKILL.md
  skill
    .command('upgrade')
    .description('Use AI to upgrade your skills (requires active proxy)')
    .option('--focus <area>', 'Focus area: code, debug, docs, speed')
    .action(async (opts) => {
      if (!isLoggedIn()) {
        console.log(clr('red', '\n  ✗ Not logged in. Run: billing login\n'));
        return;
      }

      console.log(clr('brightGreen', '\n  🌱 Analyzing your skill file...\n'));

      const current = readSkillFile();
      const stats = parseStats(current);
      const focus = opts.focus || 'code';

      console.log(clr('dim', `  Current level: ${stats.level} — ${stats.name}`));
      console.log(clr('dim', `  XP: ${stats.xp} / ${stats.xpNeeded}`));
      console.log(clr('dim', `  Upgrading focus: ${focus}\n`));

      const prompt = buildUpgradePrompt(current, focus, stats);

      try {
        const token = getToken();
        const serverUrl = getServerUrl();
        const upgraded = await callAI(serverUrl, token, prompt);

        if (!upgraded) {
          console.log(clr('yellow', '  ⚠ Could not reach AI. Make sure billing start is running.\n'));
          return;
        }

        // Parse new XP from AI response
        const newXp = Math.min(stats.xp + 25, 1500);
        const newLevel = calcLevel(newXp);

        // Update stats in SKILL.md
        const updatedMd = updateStats(current, {
          xp: newXp,
          level: newLevel.num,
          name: newLevel.name,
          xpNeeded: newLevel.next,
          upgrades: stats.upgrades + 1,
          date: new Date().toLocaleDateString('ru-RU')
        });

        // Append AI suggestions to skill file
        const finalMd = appendUpgrade(updatedMd, upgraded, focus);
        writeSkillFile(finalMd);

        // Save to history
        saveHistory({ date: new Date().toISOString(), focus, xpGained: 25, level: newLevel.num });

        console.log(clr('brightGreen', `  ✓ Skill upgraded! +25 XP\n`));
        console.log(`  Level: ${clr('cyan', newLevel.num + ' — ' + newLevel.name)}`);
        console.log(`  XP: ${clr('yellow', newXp + ' / ' + newLevel.next)}`);
        console.log(clr('dim', `\n  SKILL.md updated. Check it to see improvements.\n`));

        if (newXp >= newLevel.next) {
          console.log(clr('brightGreen', `  🎉 LEVEL UP! You are now level ${newLevel.num + 1}!\n`));
        }

      } catch (e) {
        console.log(clr('red', `  ✗ Error: ${e.message}\n`));
      }
    });

  // billing skill report  →  history
  skill
    .command('report')
    .description('Show upgrade history')
    .action(() => {
      const history = readHistory();
      if (!history.length) {
        console.log(clr('dim', '\n  No upgrades yet. Run: billing skill upgrade\n'));
        return;
      }
      console.log(clr('bold', '\n  📊 Skill History\n'));
      history.slice(-10).forEach(h => {
        const date = new Date(h.date).toLocaleDateString('ru-RU');
        console.log(`  ${clr('dim', date)}  ${clr('cyan', h.focus.padEnd(10))}  ${clr('yellow', '+' + h.xpGained + ' XP')}  Level ${h.level}`);
      });
      console.log();
    });

  // billing skill reset
  skill
    .command('reset')
    .description('Reset skill progress')
    .action(() => {
      const blank = generateBlankSkill();
      writeSkillFile(blank);
      saveHistory([]);
      console.log(clr('yellow', '\n  ✓ Skill progress reset.\n'));
    });

  // Default: billing skill → show status
  skill.action(() => {
    const data = readSkillFile();
    const stats = parseStats(data);
    printSkillCard(stats);
  });
};

// ── AI CALL ──────────────────────────────────────────────────────────
function callAI(serverUrl, token, prompt) {
  return new Promise((resolve) => {
    const url = new URL(serverUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-api-key': token,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          resolve(text);
        } catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── PROMPTS ──────────────────────────────────────────────────────────
function buildUpgradePrompt(currentSkill, focus, stats) {
  return `You are a skill upgrade system for an AI coding assistant.

Current SKILL.md:
---
${currentSkill.slice(0, 1500)}
---

The user wants to improve their "${focus}" skill area.
Current level: ${stats.level}, XP: ${stats.xp}

Generate a SHORT upgrade report (max 200 words) in this exact format:

## Upgrade: ${focus} — ${new Date().toLocaleDateString('ru-RU')}

**What improved:**
- [specific improvement 1]
- [specific improvement 2]

**New prompt enhancement for ${focus}:**
\`\`\`
[1-2 sentence prompt addition that improves ${focus} skill]
\`\`\`

**Tip:**
[one practical tip for the user]

Keep it concrete and useful. No fluff.`;
}

// ── SKILL FILE ────────────────────────────────────────────────────────
function readSkillFile() {
  if (!fs.existsSync(SKILL_FILE)) {
    const blank = generateBlankSkill();
    writeSkillFile(blank);
    return blank;
  }
  return fs.readFileSync(SKILL_FILE, 'utf8');
}

function writeSkillFile(content) {
  fs.writeFileSync(SKILL_FILE, content, 'utf8');
}

function parseStats(md) {
  const xpMatch      = md.match(/XP:\s+(\d+)\s*\/\s*(\d+)/);
  const levelMatch   = md.match(/Уровень:\s+(\d+)\s*—\s*([^\n]+)/);
  const upgradeMatch = md.match(/Апгрейдов:\s+(\d+)/);
  const requestMatch = md.match(/Запросов:\s+(\d+)/);

  const xp       = xpMatch      ? parseInt(xpMatch[1])      : 0;
  const xpNeeded = xpMatch      ? parseInt(xpMatch[2])      : 100;
  const level    = levelMatch   ? parseInt(levelMatch[1])   : 1;
  const name     = levelMatch   ? levelMatch[2].trim()      : 'Seedling 🌱';
  const upgrades = upgradeMatch ? parseInt(upgradeMatch[1]) : 0;
  const requests = requestMatch ? parseInt(requestMatch[1]) : 0;

  return { xp, xpNeeded, level, name, upgrades, requests };
}

function updateStats(md, newStats) {
  return md
    .replace(/Уровень:\s+\d+\s*—\s*[^\n]+/, `Уровень:     ${newStats.level} — ${newStats.name}`)
    .replace(/XP:\s+\d+\s*\/\s*\d+/, `XP:          ${newStats.xp} / ${newStats.xpNeeded}`)
    .replace(/Апгрейдов:\s+\d+/, `Апгрейдов:   ${newStats.upgrades}`)
    .replace(/Последнее обновление:\s+[^\n]+/, `Последнее обновление: ${newStats.date}`);
}

function appendUpgrade(md, aiText, focus) {
  const section = '\n---\n' + aiText.trim() + '\n';
  // Insert before "Пользовательские инструкции"
  if (md.includes('## Пользовательские инструкции')) {
    return md.replace('## Пользовательские инструкции', section + '\n## Пользовательские инструкции');
  }
  return md + section;
}

function generateBlankSkill() {
  return `# 🧾 Billing Skill System

Этот файл читается CLI командой \`billing skill\` и используется для самообучения.
Каждый раз когда ты запускаешь \`billing skill upgrade\` — AI анализирует и улучшает промпты.

---

## Текущий уровень

\`\`\`
Уровень:     1 — Seedling 🌱
XP:          0 / 100
Запросов:    0
Апгрейдов:   0
Последнее обновление: —
\`\`\`

---

## Активные навыки

### 🧠 Code Understanding
- Уровень: 1
- Промпт-усиление: "Analyze the code carefully before responding."

### ⚡ Response Speed
- Уровень: 1
- Промпт-усиление: "Be concise and direct."

### 🔍 Debug Mode
- Уровень: 1
- Промпт-усиление: "If there's an error, find the root cause first."

### 📝 Documentation
- Уровень: 1
- Промпт-усиление: "Add clear comments to all code."

---

## История апгрейдов

*(пусто — запусти \`billing skill upgrade\` чтобы начать)*

---

## Пользовательские инструкции для AI

\`\`\`
# Мои правила:
# - Отвечай на русском языке
# - Всегда показывай пример кода
\`\`\`
`;
}

// ── LEVELS ────────────────────────────────────────────────────────────
const LEVELS = [
  { num: 1, name: 'Seedling 🌱',  next: 100  },
  { num: 2, name: 'Sprout 🌿',    next: 300  },
  { num: 3, name: 'Branch 🌾',    next: 700  },
  { num: 4, name: 'Tree 🌳',      next: 1500 },
  { num: 5, name: 'Forest 🌲',    next: 9999 },
];

function calcLevel(xp) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= (i > 0 ? LEVELS[i-1].next : 0)) return LEVELS[i];
  }
  return LEVELS[0];
}

// ── PRINT ─────────────────────────────────────────────────────────────
function printSkillCard(stats) {
  const bar = makeBar(stats.xp, stats.xpNeeded, 20);
  console.log(clr('brightGreen', '\n  🧾 Billing Skill System\n'));
  console.log(`  Level    ${clr('cyan',    stats.level + ' — ' + stats.name)}`);
  console.log(`  XP       ${clr('yellow',  stats.xp + ' / ' + stats.xpNeeded)}  ${bar}`);
  console.log(`  Upgrades ${clr('magenta', String(stats.upgrades))}`);
  console.log(`  Requests ${clr('dim',     String(stats.requests))}`);
  console.log(clr('dim', '\n  Commands:'));
  console.log(clr('dim', '  billing skill upgrade           — upgrade with AI'));
  console.log(clr('dim', '  billing skill upgrade --focus debug — focus on debugging'));
  console.log(clr('dim', '  billing skill report            — view history\n'));
}

function makeBar(current, max, width) {
  const filled = Math.round((current / max) * width);
  const empty  = width - filled;
  return clr('green', '█'.repeat(filled)) + clr('dim', '░'.repeat(empty));
}

// ── HISTORY ───────────────────────────────────────────────────────────
function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch { return []; }
}

function saveHistory(entry) {
  const dir = require('path').dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (Array.isArray(entry)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entry));
    return;
  }
  const history = readHistory();
  history.push(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100)));
}
