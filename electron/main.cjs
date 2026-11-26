const { app, BrowserWindow, dialog, shell } = require('electron');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;
let serverPort = null;
let stopBackend = null;
let backendStarted = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function applicationPaths() {
  const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
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
  for (const [label, target] of Object.entries(paths)) {
    if (!fs.existsSync(target)) {
      throw new Error(`The packaged ${label} files are missing: ${target}`);
    }
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

  // CommonJS preserves normal Node require() semantics in the packaged runtime.
  const serverModule = require(paths.server);
  if (typeof serverModule.startServer !== 'function') {
    throw new Error('The bundled server does not export startServer(). Rebuild OmniSync Bridge.');
  }

  stopBackend = await serverModule.startServer();
  backendStarted = true;
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.omnisync.bridge');
    try {
      await createWindow();
    } catch (error) {
      console.error(error);
      dialog.showErrorBox(
        'OmniSync Bridge could not start',
        String(error && error.message ? error.message : error)
      );
      app.quit();
    }

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          await createWindow();
        } catch (error) {
          dialog.showErrorBox('OmniSync Bridge could not start', String(error.message || error));
        }
      }
    });
  });
}

app.on('before-quit', () => {
  if (stopBackend) {
    const stop = stopBackend;
    stopBackend = null;
    stop().catch((error) => console.error('Backend shutdown failed:', error));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
