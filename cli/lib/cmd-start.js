/**
 * billing start — starts local proxy server that forwards
 * AI tool requests to the Billing backend (which routes to real models)
 */

const http = require('http');
const https = require('https');
const { getToken, getServerUrl, isLoggedIn, clr, printLogo, PID_FILE, apiRequest, readConfig, writeConfig } = require('./config');
const fs = require('fs');

const PROXY_PORT = 9099; // Local port that AI tools connect to

module.exports = function(program) {
  program
    .command('start')
    .description('Start the local proxy (routes AI requests to frontier models)')
    .option('--port <port>', 'Local proxy port', String(PROXY_PORT))
    .option('--key <apikey>', 'API key from the dashboard (bill_sk_...)')
    .action(async (opts) => {
      printLogo();

      // If --key passed, save it to config and use it
      if (opts.key) {
        if (!opts.key.startsWith('bill_sk_')) {
          console.error(clr('red', '  ✗ Invalid API key format. Keys start with bill_sk_\n'));
          process.exit(1);
        }
        const cfg = readConfig();
        writeConfig({ ...cfg, apiKey: opts.key });
        console.log(clr('brightGreen', '  ✓ API key saved\n'));
      }

      // Determine which credential to use: saved API key > session token
      const cfg = readConfig();
      const apiKey = cfg.apiKey || getToken();

      if (!apiKey) {
        console.error(clr('red', '  ✗ No credentials found.\n'));
        console.error(clr('dim', '  Option 1 (recommended): billing start --key bill_sk_ВашКлючССайта'));
        console.error(clr('dim', '  Option 2: billing login  (email + password)\n'));
        process.exit(1);
      }

      // Verify credentials against server
      try {
        // Try as API key first via /v1/messages probe, fallback to session check
        const res = await apiRequest('GET', '/api/auth/me', null, apiKey);
        if (res.status !== 200) {
          console.error(clr('red', '  ✗ Invalid or expired credentials.\n'));
          console.error(clr('dim', '  Run: billing start --key bill_sk_ВашКлючССайта\n'));
          process.exit(1);
        }
        const user = res.data;
        console.log(clr('brightGreen', `  ✓ Authenticated as ${clr('bold', user.name)} (${user.email})`));
      } catch (e) {
        console.error(clr('red', `  ✗ Could not reach server: ${e.message}\n`));
        console.error(clr('dim', `    Server: ${getServerUrl()}`));
        console.error(clr('dim', `    Make sure the server is running.\n`));
        process.exit(1);
      }

      const port = parseInt(opts.port);
      const serverUrl = new URL(getServerUrl());
      const codename = randomCodename();

      console.log(clr('dim', `  Assigned model codename: ${clr('cyan', codename)}`));
      console.log(clr('dim', `  Starting proxy on port ${port}...\n`));

      // Create local proxy server
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          const bodyBuf = Buffer.from(body);
          const isHttps = serverUrl.protocol === 'https:';
          const lib = isHttps ? https : http;

          const options = {
            hostname: serverUrl.hostname,
            port: serverUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: serverUrl.hostname,
              'x-api-key': apiKey,
              'authorization': `Bearer ${apiKey}`,
              'content-length': bodyBuf.length,
            }
          };

          const proxyReq = lib.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (e) => {
            console.error(clr('red', `  Proxy error: ${e.message}`));
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'Proxy error: ' + e.message }));
          });

          proxyReq.write(bodyBuf);
          proxyReq.end();
        });
      });

      server.listen(port, '127.0.0.1', () => {
        fs.writeFileSync(PID_FILE, String(process.pid));

        console.log(clr('brightGreen', `  🌱 Proxy running!\n`));
        console.log(`  ${clr('bold', 'Proxy URL:')}     ${clr('cyan', `http://127.0.0.1:${port}`)}`);
        console.log(`  ${clr('bold', 'Model:')}         ${clr('yellow', codename)} (stealth mode)`);
        console.log(`  ${clr('bold', 'API format:')}    Anthropic Messages API\n`);
        console.log(clr('dim', '  ──────────────────────────────────────'));
        console.log(clr('bold', '  Подключи AI инструмент:\n'));
        console.log(`  ${clr('cyan', 'Claude Code:')}    ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
        console.log(`  ${clr('cyan', 'Cursor:')}         Base URL → http://127.0.0.1:${port}`);
        console.log(`  ${clr('cyan', 'Cline/RooCode:')} API Base URL → http://127.0.0.1:${port}`);
        console.log(`  ${clr('cyan', 'Windsurf:')}       Base URL → http://127.0.0.1:${port}`);
        console.log(clr('dim', '\n  ──────────────────────────────────────'));
        console.log(clr('dim', '  Press Ctrl+C to stop\n'));
      });

      process.on('SIGINT', () => {
        server.close(() => {
          try { fs.unlinkSync(PID_FILE); } catch {}
          console.log(clr('yellow', '\n\n  🌿 Stopped. Happy coding!\n'));
          process.exit(0);
        });
      });
    });
};

const CODENAMES = [
  'cute-koala','angry-giraffe','happy-panda','lazy-fox',
  'swift-eagle','brave-wolf','wise-owl','silly-penguin',
  'grumpy-bear','jolly-dolphin','sneaky-cat','bold-tiger'
];
function randomCodename() { return CODENAMES[Math.floor(Math.random() * CODENAMES.length)]; }
