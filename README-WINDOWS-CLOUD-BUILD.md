# OmniSync Bridge — Windows cloud build

The Windows desktop packaging uses Electron Builder and GitHub Actions.

## Outputs

The workflow creates two x64 Windows builds:

- **NSIS installer:** a standard Windows setup executable.
- **Portable executable:** a standalone executable that does not require an installer.

## How it works

- Vite builds the React renderer into `dist/`.
- esbuild bundles the Express/WebSocket Node server into `dist-server/server.mjs`.
- Electron starts the bundled server on a free local port and opens the renderer in a desktop window.
- Sync data is stored in Electron's per-user application data folder.
- The existing Python receiver HTML/script assets are packaged under `public/` and remain available from the server's receiver download routes.

## Build

Pushing relevant changes to `main` starts **Build OmniSync Bridge for Windows** automatically. A manual run is also available under GitHub Actions → Build OmniSync Bridge for Windows → Run workflow.

The build uploads the NSIS and portable executables as the `OmniSync-Bridge-Windows` workflow artifact.

## Python receiver and virtual gamepad requirements

The Python receiver remains a separately launched companion script. It is included as an application asset and is made available through the existing receiver download and launcher routes. The desktop packaging does not embed or silently install a Python runtime, `vgamepad`, or the ViGEmBus driver.

For Xbox 360 virtual-controller output on Windows, install a compatible Python 3 runtime, install the receiver's required Python package(s), and install the supported ViGEmBus driver. The receiver also supports keyboard/mouse output using Windows SendInput. Review the receiver setup instructions in the app before use.

## Validation

A successful GitHub Actions build confirms the two installer artifacts were generated. Test both on a Windows PC, including phone-to-PC LAN pairing and the Python receiver/driver setup, before distributing them.
