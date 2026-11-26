const { app, BrowserWindow, dialog, shell } = require('electron');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;
let serverPort = null;
let stopBackend = null;
let backendStarted = false;
let quitting = false;
let logFile = null;

function log(level, message, detail) {
  const suffix = detail === undefined
    ? ''
    : detail instanceof Error
      ? `\n${detail.stack || detail.message}`
      : `\n${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}\n`;

  try {
    if (!logFile) {
      const logDirectory = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDirectory, { recursive: true });
      logFile = path.join(logDirectory, 'startup.log');
    }
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (writeError) {
    console.error('Could not write OmniSync startup log:', writeError);
  }
  if (level === 'ERROR') console.error(line);
}

function getLogPath() {
  try {
    return logFile || path.join(app.getPath('userData'), 'logs', 'startup.log');
  } catch {
    return 'the OmniSync user-data logs folder';
  }
}

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught main-process exception', error);
  if (!quitting) {
    try {
      dialog.showErrorBox('OmniSync Bridge crashed', `${error.message || error}\n\nLog: ${getLogPath()}`);
    } catch (_) {}
    app.quit();
  }
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled main-process rejection', reason instanceof Error ? reason : String(reason));
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
log('INFO', 'Application process started', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  executable: process.execPath,
  singleInstanceLock: hasSingleInstanceLock,
});

if (!hasSingleInstanceLock) {
  log('WARN', 'Another OmniSync Bridge instance already owns the single-instance lock');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('INFO', 'Second launch detected; focusing existing window');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function applicationPaths() {
  // app.getAppPath() is the authoritative path for both app/ and app.asar layouts.
  const appRoot = app.isPackaged
    ? app.getAppPath()
    : path.resolve(__dirname, '..');

  return {
    server: path.join(appRoot, 'dist-server', 'server.cjs'),
    renderer: path.join(appRoot, 'dist'),
    public: path.join(appRoot, 'public'),
    root: appRoot,
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startBackend() {
  if (backendStarted) return;

  const paths = applicationPaths();
  log('INFO', 'Resolved application paths', paths);

  for (const [label, target] of Object.entries(paths)) {
    if (!fs.existsSync(target)) {
      throw new Error(`Packaged ${label} path does not exist: ${target}`);
    }
  }

  const rendererIndex = path.join(paths.renderer, 'index.html');
  if (!fs.existsSync(rendererIndex)) {
    throw new Error(`Packaged renderer entry point is missing: ${rendererIndex}`);
  }

  serverPort = await findFreePort();
  const dataDirectory = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });

  process.env.NODE_ENV = 'production';
  process.env.ELECTRON_MAIN_PROCESS = 'true';
  process.env.PORT = String(serverPort);
  process.env.APP_DATA_DIR = dataDirectory;
  process.env.APP_DIST_DIR = paths.renderer;
  process.env.APP_PUBLIC_DIR = paths.public;
  process.env.APP_ROOT_DIR = paths.root;

  log('INFO', `Starting bundled Node server on port ${serverPort}`);
  const serverModule = require(paths.server);

  if (typeof serverModule.startServer !== 'function') {
    throw new Error('Bundled server does not export startServer().');
  }

  stopBackend = await serverModule.startServer();
  backendStarted = true;
  log('INFO', 'Bundled Node server started successfully');
}

async function createWindow() {
  if (!backendStarted) await startBackend();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: '#090a0d',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('ready-to-show', () => {
    log('INFO', 'BrowserWindow ready-to-show event fired');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('INFO', 'Renderer finished loading');
    // Fallback also handles the case where ready-to-show fired before its listener.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log('WARN', 'Showing window after did-finish-load fallback');
      mainWindow.show();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    log('ERROR', 'Renderer failed to load', { code, description, url, isMainFrame });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('ERROR', 'Renderer process exited unexpectedly', details);
  });

  mainWindow.on('unresponsive', () => log('ERROR', 'Application window became unresponsive'));
  mainWindow.on('closed', () => {
    log('INFO', 'Application window closed');
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const localUrl = `http://127.0.0.1:${serverPort}`;
  log('INFO', `Loading renderer from ${localUrl}`);
  await mainWindow.loadURL(localUrl);

  // Never leave the only application window hidden if an event was emitted early.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    log('INFO', 'Showing application window after loadURL completed');
    mainWindow.show();
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.omnisync.bridge');
    log('INFO', 'Electron app is ready');

    try {
      await createWindow();
    } catch (error) {
      log('ERROR', 'Startup failed', error);
      dialog.showErrorBox(
        'OmniSync Bridge could not start',
        `${error && error.message ? error.message : error}\n\nDiagnostic log: ${getLogPath()}`
      );
      app.quit();
    }

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          await createWindow();
        } catch (error) {
          log('ERROR', 'Window recreation failed', error);
          dialog.showErrorBox(
            'OmniSync Bridge could not start',
            `${error.message || error}\n\nDiagnostic log: ${getLogPath()}`
          );
        }
      }
    });
  }).catch((error) => {
    log('ERROR', 'Electron app-ready handler failed', error);
    dialog.showErrorBox('OmniSync Bridge startup failed', `${error.message || error}\n\nLog: ${getLogPath()}`);
    app.quit();
  });
}

app.on('before-quit', () => {
  quitting = true;
  log('INFO', 'Application is quitting');
  if (stopBackend) {
    const stop = stopBackend;
    stopBackend = null;
    stop().catch((error) => log('ERROR', 'Backend shutdown failed', error));
  }
});

app.on('window-all-closed', () => {
  log('INFO', 'All application windows closed');
  if (process.platform !== 'darwin') app.quit();
});
