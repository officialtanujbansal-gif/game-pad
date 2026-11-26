const { app, BrowserWindow, dialog, shell } = require('electron');
const { ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;
let serverPort = null;
let stopBackend = null;
let backendStarted = false;
let quitting = false;
let logFile = null;
let receiverProcess = null;
let receiverPin = null;
let receiverMissingDialogShown = false;

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
    preload: path.join(appRoot, 'electron', 'preload.cjs'),
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


function stopWindowsReceiver(reason = 'application shutdown') {
  if (!receiverProcess) return;
  const child = receiverProcess;
  receiverProcess = null;
  receiverPin = null;
  log('INFO', `Stopping Windows receiver: ${reason}`);

  // The BAT runs Python as its child. Kill the complete process tree so no
  // orphan receiver keeps sending input after OmniSync exits or changes PIN.
  if (child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch (error) {
      log('WARN', 'Could not terminate the Windows receiver process tree', error);
    }
  }
  try {
    child.kill();
  } catch (error) {
    log('WARN', 'Could not stop Windows receiver launcher cleanly', error);
  }
}

function hasPython3() {
  const candidates = [
    { command: 'py', args: ['-3', '--version'] },
    { command: 'python', args: ['--version'] },
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function startWindowsReceiver(pin) {
  if (process.platform !== 'win32') return { started: false, reason: 'not-windows' };
  if (!/^\d{4,12}$/.test(String(pin || ''))) {
    throw new Error('The pairing PIN must contain 4 to 12 digits before the Windows receiver can start.');
  }
  if (!app.isPackaged) {
    log('WARN', 'Automatic Windows receiver launch is available in the packaged desktop build only.');
    return { started: false, reason: 'development-build' };
  }

  const receiverDir = path.join(process.resourcesPath, 'receiver');
  const receiverScript = path.join(receiverDir, 'redlinepad_windows_receiver.py');
  const launcher = path.join(receiverDir, 'Launch_RedlinePad_Windows.bat');

  for (const requiredFile of [receiverScript, launcher]) {
    if (!fs.existsSync(requiredFile)) {
      const message = `Bundled Windows receiver file is missing: ${requiredFile}`;
      log('ERROR', message);
      if (!receiverMissingDialogShown) {
        receiverMissingDialogShown = true;
        dialog.showErrorBox(
          'OmniSync Windows Receiver is missing',
          `This installation does not include the automatic controller receiver. Reinstall the latest OmniSync Bridge build.\n\n${message}\n\nDiagnostic log: ${getLogPath()}`
        );
      }
      throw new Error(message);
    }
  }

  if (!hasPython3()) {
    const message = 'Python 3 was not found. Install Python 3 for Windows, enable "Add python.exe to PATH", then restart OmniSync Bridge.';
    log('ERROR', message);
    if (!receiverMissingDialogShown) {
      receiverMissingDialogShown = true;
      dialog.showErrorBox(
        'Python 3 is required for controller output',
        `${message}\n\nDownload: https://www.python.org/downloads/windows/\n\nDiagnostic log: ${getLogPath()}`
      );
    }
    return { started: false, reason: 'python-missing' };
  }

  if (receiverProcess && receiverPin === pin && receiverProcess.exitCode === null) {
    return { started: true, alreadyRunning: true };
  }

  stopWindowsReceiver('pairing PIN changed');
  const relayUrl = `ws://127.0.0.1:${serverPort}/ws`;
  log('INFO', 'Starting Windows receiver through bundled BAT launcher', {
    launcher,
    relayUrl,
    pairingPinConfigured: true,
  });

  // Keep cmd.exe attached to the BAT. The BAT then runs Python in this same
  // process tree, so stdout/stderr stay visible in startup.log.
  const command = `call "${launcher}" "${pin}" "${relayUrl}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: receiverDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, OMNISYNC_AUTOSTART: '1' },
  });
  receiverProcess = child;
  receiverPin = pin;

  const logReceiverLines = (level, chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
      const safeLine = line.replace(/(PIN\s*:?\s*)\d{4,12}/gi, '$1[redacted]');
      log(level, `[receiver] ${safeLine}`);
    }
  };
  child.stdout.on('data', (chunk) => logReceiverLines('INFO', chunk));
  child.stderr.on('data', (chunk) => logReceiverLines('WARN', chunk));
  child.on('spawn', () => log('INFO', 'Windows receiver BAT launcher spawned'));
  child.on('error', (error) => {
    if (receiverProcess === child) {
      receiverProcess = null;
      receiverPin = null;
    }
    log('ERROR', 'Windows receiver BAT launcher failed to start', error);
    if (!quitting) {
      dialog.showErrorBox(
        'OmniSync Windows Receiver could not start',
        `${error.message || error}\n\nDiagnostic log: ${getLogPath()}`
      );
    }
  });
  child.on('exit', (code, signal) => {
    if (receiverProcess === child) {
      receiverProcess = null;
      receiverPin = null;
    }
    log(code === 0 ? 'INFO' : 'ERROR', 'Windows receiver launcher exited', { code, signal });
    if (code !== 0 && !quitting) {
      dialog.showErrorBox(
        'OmniSync Windows Receiver stopped',
        `The receiver exited with code ${code}. Check Python and package installation, then inspect the diagnostic log: ${getLogPath()}`
      );
    }
  });

  return { started: true, alreadyRunning: false };
}

ipcMain.handle('omnisync:receiver:set-pin', (event, pin) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Receiver startup request came from an untrusted window.');
  }
  const frameUrl = event.senderFrame && event.senderFrame.url ? event.senderFrame.url : '';
  if (!frameUrl.startsWith(`http://127.0.0.1:${serverPort}/`)) {
    throw new Error('Receiver startup request did not originate from the local OmniSync app.');
  }
  return startWindowsReceiver(String(pin || ''));
});

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
      preload: applicationPaths().preload,
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
  stopWindowsReceiver('application shutdown');
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
