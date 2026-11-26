import { useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { DesktopCompanionHub } from './components/DesktopCompanionHub';
import { OfflineIndicator } from './components/PWAInstallButton';
import { TouchController } from './components/TouchController';
import { useGamepadSync } from './hooks/useGamepadSync';
import { isMobileViewportOrTouch } from './hooks/usePWAInstall';

type AppMode = 'desktop' | 'pad';

function detectInitialMode(): AppMode {
  if (typeof window === 'undefined') return 'desktop';
  const params = new URLSearchParams(window.location.search);
  const modeParam = params.get('mode');
  if (modeParam === 'pad') return 'pad';
  if (modeParam === 'desktop') return 'desktop';
  return isMobileViewportOrTouch() ? 'pad' : 'desktop';
}

export default function App() {
  const [mode, setMode] = useState<AppMode>(() => detectInitialMode());

  // Clean up ?mode= param after initial launch while preserving bookmarkable URL
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('mode')) {
        url.searchParams.delete('mode');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch {
      // ignore
    }
  }, []);

  const sync = useGamepadSync(mode === 'pad' ? 'phone' : 'desktop');

  // The Electron desktop shell starts the native Windows receiver as soon as
  // the shared pairing PIN is available. Ordinary browser/PWA sessions have no
  // preload API, so they remain unaffected.
  useEffect(() => {
    if (!/^\\d{4,12}$/.test(sync.pin)) return;
    const receiverApi = window.omniSyncBridge;
    if (!receiverApi) return;
    receiverApi.setPairingPin(sync.pin).catch((error) => {
      console.error('OmniSync Windows receiver could not be started:', error);
    });
  }, [sync.pin]);

  return (
    <MotionConfig reducedMotion="user">
      {mode === 'pad' ? (
        <TouchController
          pin={sync.pin}
          onPinChange={sync.setPin}
          transport={sync.transport}
          onTransportChange={sync.setTransport}
          lanAddress={sync.lanAddress}
          onLanAddressChange={sync.setLanAddress}
          settings={sync.settings}
          onUpdateSettings={sync.updateSettings}
          connectionState={sync.connectionState}
          rtt={sync.rtt}
          devices={sync.devices}
          caps={sync.caps}
          syncPulse={sync.syncPulse}
          onSendInput={sync.sendInput}
          onReleaseAll={sync.releaseAll}
          onSwitchToDesktopHub={() => {
            sync.releaseAll();
            setMode('desktop');
          }}
        />
      ) : (
        <DesktopCompanionHub
          pin={sync.pin}
          onPinChange={sync.setPin}
          onGenerateNewPin={sync.createNewPin}
          settings={sync.settings}
          onUpdateSettings={sync.updateSettings}
          connectionState={sync.connectionState}
          rtt={sync.rtt}
          devices={sync.devices}
          caps={sync.caps}
          syncPulse={sync.syncPulse}
          liveInput={sync.liveInput}
          onSendInput={sync.sendInput}
          onOpenController={() => setMode('pad')}
        />
      )}
      <OfflineIndicator />
    </MotionConfig>
  );
}
