const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const port = 43871;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisync-smoke-'));

  process.env.NODE_ENV = 'production';
  process.env.ELECTRON_MAIN_PROCESS = 'true';
  process.env.PORT = String(port);
  process.env.APP_ROOT_DIR = process.cwd();
  process.env.APP_DATA_DIR = dataDir;
  process.env.APP_DIST_DIR = path.resolve('dist');
  process.env.APP_PUBLIC_DIR = path.resolve('public');

  let stop;
  try {
    const server = require(path.resolve('dist-server/server.cjs'));
    if (typeof server.startServer !== 'function') {
      throw new Error('Bundled server does not export startServer().');
    }

    stop = await server.startServer();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}`);

    const health = await response.json();
    if (health.ok !== true) throw new Error('Health endpoint did not return ok=true.');
    process.stdout.write('PASS: bundled server started and /api/health responded.\n');
  } finally {
    if (stop) await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL: bundled server smoke test', error);
  process.exitCode = 1;
});
