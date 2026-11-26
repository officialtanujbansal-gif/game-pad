// Starts the bundled Express/WebSocket server for the Windows receiver build step.
process.env.ELECTRON_MAIN_PROCESS = 'true';
process.env.NODE_ENV = 'production';
require('../dist-server/server.cjs').startServer().catch((error) => {
  console.error('Build-time relay server failed:', error);
  process.exit(1);
});
