import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Gamepad2,
  Globe,
  Laptop,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sun,
  Terminal,
  Trash2,
  Wifi,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import QRCode from 'qrcode';
import { ConnectionState } from '../hooks/useGamepadSync';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { LAYOUT_ORDER, LAYOUTS } from '../lib/layouts';
import {
  ConnectedDevice,
  GamepadProfile,
  LayoutId,
  LiveInputState,
  SyncedSettings,
  TextureFinish,
  VigemReleaseInfo,
} from '../types/gamepad';
import { PWAInstallButton } from './PWAInstallButton';
import { RealisticControllerPreview } from './RealisticControllerPreview';

type HubTab = 'receiver' | 'windows' | 'sync' | 'install';

interface DesktopCompanionHubProps {
  pin: string;
  onPinChange: (pin: string) => void;
  onGenerateNewPin: () => Promise<string>;
  settings: SyncedSettings;
  onUpdateSettings: (
    updater: Partial<SyncedSettings> | ((prev: SyncedSettings) => SyncedSettings)
  ) => void;
  connectionState: ConnectionState;
  rtt: number | null;
  devices: ConnectedDevice[];
  caps: { pad: string | null; kbm: string | null };
  syncPulse: 'idle' | 'syncing' | 'synced';
  liveInput: LiveInputState;
  onSendInput: (payload: Record<string, unknown>) => void;
  onOpenController: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '6.0 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export const DesktopCompanionHub: React.FC<DesktopCompanionHubProps> = ({
  pin,
  onPinChange,
  onGenerateNewPin,
  settings,
  onUpdateSettings,
  connectionState,
  rtt,
  devices,
  caps,
  syncPulse,
  liveInput,
  onSendInput,
  onOpenController,
}) => {
  const [activeTab, setActiveTab] = useState<HubTab>('receiver');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedPin, setCopiedPin] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [pinInput, setPinInput] = useState(pin);
  const [newProfileName, setNewProfileName] = useState('');
  const [vigemRelease, setVigemRelease] = useState<VigemReleaseInfo | null>(null);
  const [vigemLoading, setVigemLoading] = useState(true);

  // Direct IP vs Shared Public URL QR state (prevents 403 errors on phone browsers)
  const [networkInfo, setNetworkInfo] = useState<{
    isDevProxy: boolean;
    sharedAppUrl: string;
    localServerIps: string[];
    defaultLanPort: number;
  }>({
    isDevProxy:
      typeof window !== 'undefined' && window.location.hostname.startsWith('ais-dev-'),
    sharedAppUrl:
      typeof window !== 'undefined'
        ? window.location.origin.replace('://ais-dev-', '://ais-pre-')
        : '',
    localServerIps: [],
    defaultLanPort: 8765,
  });

  const [manualLanIp, setManualLanIp] = useState<string>(() => {
    try {
      return localStorage.getItem('redlinepad.pcLanIp.v1') || '';
    } catch {
      return '';
    }
  });

  const [qrMode, setQrMode] = useState<'ip' | 'web'>(() => {
    try {
      const savedIp = localStorage.getItem('redlinepad.pcLanIp.v1');
      if (savedIp) return 'ip';
    } catch {
      // ignore
    }
    return typeof window !== 'undefined' && window.location.hostname.startsWith('ais-dev-')
      ? 'ip'
      : 'web';
  });

  const { isInstallable, isInstalled, install } = usePWAInstall();

  useEffect(() => {
    setPinInput(pin);
  }, [pin]);

  // Fetch server network & public shareable URL info
  useEffect(() => {
    let cancelled = false;
    fetch('/api/network-info')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data && typeof data === 'object') {
          setNetworkInfo({
            isDevProxy: Boolean(data.isDevProxy),
            sharedAppUrl: String(data.sharedAppUrl || ''),
            localServerIps: Array.isArray(data.localServerIps) ? data.localServerIps : [],
            defaultLanPort: Number(data.defaultLanPort || 8765),
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Collect any real LAN IP URLs reported by a connected Windows Receiver Bridge or local server
  const detectedLanUrls = Array.from(
    new Set([
      ...devices.flatMap((d) => d.lanUrls || []),
      ...networkInfo.localServerIps,
    ])
  );

  // Auto-populate PC Wi-Fi IP as soon as Windows Bridge connects
  useEffect(() => {
    if (!manualLanIp && detectedLanUrls.length > 0) {
      const firstHost = detectedLanUrls[0].replace(/^https?:\/\//, '');
      setManualLanIp(firstHost);
      setQrMode('ip');
    }
  }, [detectedLanUrls, manualLanIp]);

  const handleManualIpChange = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.:]/g, '').slice(0, 26);
    setManualLanIp(cleaned);
    try {
      localStorage.setItem('redlinepad.pcLanIp.v1', cleaned);
    } catch {
      // ignore
    }
  };

  // Build exact non-403 QR pairing URL
  const normalizedLanBase = (() => {
    const v = manualLanIp.trim();
    if (!v) return '';
    const hasPort = v.includes(':');
    const hostPort = hasPort ? v : `${v}:${networkInfo.defaultLanPort}`;
    return `http://${hostPort}`;
  })();

  const shareableWebBase =
    networkInfo.sharedAppUrl ||
    (typeof window !== 'undefined'
      ? window.location.origin.replace('://ais-dev-', '://ais-pre-')
      : '');

  const activeQrUrl = (() => {
    if (!pin) return '';
    if (qrMode === 'ip') {
      if (!normalizedLanBase) return '';
      return `${normalizedLanBase}/?pin=${encodeURIComponent(pin)}`;
    }
    return `${shareableWebBase}/?pin=${encodeURIComponent(pin)}&mode=pad`;
  })();

  // Generate crisp QR code from activeQrUrl
  useEffect(() => {
    if (!activeQrUrl) {
      setQrDataUrl('');
      return;
    }
    QRCode.toDataURL(activeQrUrl, {
      width: 220,
      margin: 1,
      color: {
        dark: '#090a0d',
        light: '#ffffff',
      },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [activeQrUrl]);

  // Load live ViGEmBus GitHub Releases metadata
  useEffect(() => {
    let cancelled = false;
    setVigemLoading(true);
    fetch('/api/vigem/releases')
      .then((r) => r.json())
      .then((data: VigemReleaseInfo) => {
        if (!cancelled) {
          setVigemRelease(data);
          setVigemLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setVigemLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopyPin = async () => {
    try {
      await navigator.clipboard.writeText(pin);
      setCopiedPin(true);
      window.setTimeout(() => setCopiedPin(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleCopyQrUrl = async () => {
    if (!activeQrUrl) return;
    try {
      await navigator.clipboard.writeText(activeQrUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // ignore
    }
  };

  const bridgeCmd = `pip install vgamepad websockets && python redlinepad_windows_receiver.py --pin ${pin || '123456'}`;

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(bridgeCmd);
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleApplyProfile = (profile: GamepadProfile) => {
    onUpdateSettings({
      layout: profile.layout,
      sens: profile.sens,
      gain: profile.gain,
      deadzone: profile.deadzone,
      vib: profile.vib,
      tap: profile.tap,
      audioClick: profile.audioClick,
      activeProfileId: profile.id,
    });
  };

  const handleCreateProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newProfileName.trim();
    if (!name) return;
    const id = `custom-${Date.now()}`;
    const created: GamepadProfile = {
      id,
      name: name.slice(0, 48),
      layout: settings.layout,
      sens: settings.sens,
      gain: settings.gain,
      deadzone: settings.deadzone,
      vib: settings.vib,
      tap: settings.tap,
      audioClick: settings.audioClick,
      updatedAt: Date.now(),
    };
    onUpdateSettings((prev) => ({
      ...prev,
      profiles: [...prev.profiles, created],
      activeProfileId: id,
    }));
    setNewProfileName('');
  };

  const handleDeleteProfile = (id: string) => {
    onUpdateSettings((prev) => {
      const remaining = prev.profiles.filter((p) => p.id !== id);
      if (remaining.length === 0) return prev;
      return {
        ...prev,
        profiles: remaining,
        activeProfileId: prev.activeProfileId === id ? remaining[0].id : prev.activeProfileId,
      };
    });
  };

  const bridgeConnected = devices.some((d) => d.role === 'bridge');
  const phoneConnected = devices.some((d) => d.role === 'phone');
  const customLayoutEntries = Object.entries(settings.customLayouts).filter(
    ([, controls]) => controls && Object.keys(controls).length > 0
  );

  return (
    <div className="min-h-screen bg-[#f4f5f8] text-zinc-900 transition-colors dark:bg-[#090a0d] dark:text-[#eef0f5]">
      {/* Strict 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur-md dark:border-zinc-800/90 dark:bg-[#0c0d12]/90">
        <div className="mx-auto flex max-w-[1360px] items-center justify-between gap-8 px-6 py-3.5">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('receiver')}
            className="font-display text-lg font-bold tracking-tight text-zinc-950 dark:text-white whitespace-nowrap shrink-0"
          >
            RedlinePad
          </button>

          {/* Zone 2: 4 Single-Line Text Nav Links */}
          <nav className="hidden items-center gap-7 text-sm font-medium md:flex" aria-label="Primary navigation">
            {(
              [
                { id: 'receiver', label: 'Live Receiver' },
                { id: 'windows', label: 'ViGEmBus & Windows' },
                { id: 'sync', label: 'Sync & Profiles' },
                { id: 'install', label: 'Install Apps' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`relative py-1 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === item.id
                    ? 'text-zinc-950 dark:text-white'
                    : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {item.label}
                {activeTab === item.id && (
                  <motion.span
                    layoutId="hubNavUnderline"
                    className="absolute inset-x-0 -bottom-[15px] h-0.5 bg-[#e11d48]"
                  />
                )}
              </button>
            ))}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={onOpenController}
              className="inline-flex items-center gap-2 rounded-lg bg-[#e11d48] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#be123c] active:scale-[0.98] whitespace-nowrap shrink-0"
            >
              <Gamepad2 className="h-3.5 w-3.5" />
              <span>Open Touch Pad</span>
            </button>
          </div>
        </div>

        {/* Mobile Sub-Navigation Bar for Smaller Viewports */}
        <div className="flex items-center gap-1 overflow-x-auto border-t border-zinc-200 px-4 py-2 dark:border-zinc-800 md:hidden">
          {(
            [
              { id: 'receiver', label: 'Receiver' },
              { id: 'windows', label: 'ViGEmBus' },
              { id: 'sync', label: 'Sync' },
              { id: 'install', label: 'Install' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap shrink-0 ${
                activeTab === item.id
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950'
                  : 'text-zinc-600 dark:text-zinc-400'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-[1360px] px-6 py-8">
        {/* Clean Contextual Status & Utility Line (Unboxed Typography, Zero Pills) */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-5 dark:border-zinc-800/80">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-zinc-950 dark:text-white sm:text-3xl">
              {activeTab === 'receiver' && 'Cross-Platform Controller Studio'}
              {activeTab === 'windows' && 'Windows ViGEmBus & Receiver Bridge'}
              {activeTab === 'sync' && 'Real-Time Profile & Layout Sync'}
              {activeTab === 'install' && 'Install on iOS, Android & Windows'}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              <span>
                Session PIN{' '}
                <strong className="font-mono-tabular text-zinc-800 dark:text-zinc-200">{pin || '------'}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    connectionState === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                {connectionState === 'connected'
                  ? `Relay Connected${rtt !== null ? ` (${rtt} ms)` : ''}`
                  : 'Connecting to Sync Relay'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {devices.length} {devices.length === 1 ? 'device' : 'devices'} paired
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {syncPulse === 'syncing' ? 'Syncing changes...' : 'Cross-platform sync up to date'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() =>
                onUpdateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
              }
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-800 dark:bg-[#13151d] dark:text-zinc-200 dark:hover:bg-zinc-800 whitespace-nowrap"
              aria-label="Toggle dark and light theme"
            >
              {settings.theme === 'dark' ? (
                <>
                  <Sun className="h-3.5 w-3.5" /> Light Theme
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5" /> Dark Theme
                </>
              )}
            </button>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {/* TAB 1: LIVE RECEIVER & CONTROLLER STUDIO */}
          {activeTab === 'receiver' && (
            <motion.div
              key="receiver"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 gap-6 lg:grid-cols-12"
            >
              {/* Left 8-Col Dominant Anchor: Live Realistic Controller Preview */}
              <section className="flex flex-col justify-between rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a] lg:col-span-8">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-display text-base font-semibold">
                      Live Hardware Telemetry & Test Pad
                    </h2>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      Mirrors iOS and Android inputs at 60 fps. Click any button below to test Windows ViGEmBus output.
                    </p>
                  </div>
                  <div className="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-[#0a0b10]">
                    {LAYOUT_ORDER.map((lid) => (
                      <button
                        key={lid}
                        type="button"
                        onClick={() => onUpdateSettings({ layout: lid })}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                          settings.layout === lid
                            ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
                            : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                        }`}
                      >
                        {LAYOUTS[lid].shortTitle}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="my-2 py-2">
                  <RealisticControllerPreview
                    liveInput={liveInput}
                    texture={settings.texture}
                    onTestButton={(btnId, down) => onSendInput({ t: 'b', k: btnId, v: down ? 1 : 0 })}
                    onTestTrigger={(trId, val) => onSendInput({ t: 'tr', k: trId, v: val })}
                  />
                </div>

                {/* Output Driver Readiness Row */}
                <div className="mt-4 grid grid-cols-1 gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800 sm:grid-cols-3">
                  <div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">Active Layout</div>
                    <div className="mt-0.5 text-sm font-semibold">
                      {LAYOUTS[settings.layout].title}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">Xbox 360 Driver</div>
                    <div className="mt-0.5 text-sm font-semibold">
                      {bridgeConnected ? (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          {caps.pad || 'ViGEmBus Active'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActiveTab('windows')}
                          className="text-left text-[#e11d48] underline-offset-2 hover:underline"
                        >
                          Download Windows Bridge
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">Live Packets</div>
                    <div className="font-mono-tabular mt-0.5 text-sm font-semibold">
                      {liveInput.packetCount.toLocaleString()} events
                    </div>
                  </div>
                </div>
              </section>

              {/* Right 4-Col Panel: Instant Phone Pairing (Direct IP QR + Shared URL + PIN) */}
              <aside className="flex flex-col justify-between gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a] lg:col-span-4">
                <div>
                  <h2 className="font-display text-base font-semibold">Pair iPhone or Android</h2>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    Connect directly over local Wi-Fi IP (zero login, no 403 errors) or via the shared web URL.
                  </p>

                  {/* Segmented QR Mode Switcher */}
                  <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-[#0a0b10]">
                    <button
                      type="button"
                      onClick={() => setQrMode('ip')}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                        qrMode === 'ip'
                          ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                      }`}
                    >
                      <Wifi className="h-3.5 w-3.5" />
                      <span>Direct IP (Wi-Fi)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setQrMode('web')}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                        qrMode === 'web'
                          ? 'bg-white text-zinc-950 shadow-sm dark:bg-zinc-800 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                      }`}
                    >
                      <Globe className="h-3.5 w-3.5" />
                      <span>Shared Web URL</span>
                    </button>
                  </div>

                  {/* Direct IP Input & Auto-Detected LAN IPs */}
                  {qrMode === 'ip' && (
                    <div className="mt-3 space-y-2">
                      <label className="block text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                        Windows PC Wi-Fi IP Address (Port {networkInfo.defaultLanPort})
                      </label>
                      <input
                        type="text"
                        value={manualLanIp}
                        onChange={(e) => handleManualIpChange(e.target.value)}
                        placeholder="e.g. 192.168.1.42 or 192.168.1.42:8765"
                        className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono-tabular text-xs dark:border-zinc-700"
                      />
                      {detectedLanUrls.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {detectedLanUrls.map((url) => {
                            const hostPort = url.replace(/^https?:\/\//, '');
                            return (
                              <button
                                key={url}
                                type="button"
                                onClick={() => handleManualIpChange(hostPort)}
                                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono-tabular text-[11px] font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                              >
                                {hostPort}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* QR Code Frame */}
                  <div className="mt-4 flex flex-col items-center rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-[#0b0c11]">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt={`Pairing QR code for ${activeQrUrl}`}
                        className="h-44 w-44 rounded-lg bg-white p-2 shadow-sm"
                      />
                    ) : (
                      <div className="flex h-44 w-44 flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-white/60 p-4 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">
                        <Wifi className="mb-2 h-6 w-6 text-[#e11d48]" />
                        <span>Enter your PC Wi-Fi IP above (or start the Windows Receiver) to generate a direct IP QR code.</span>
                      </div>
                    )}

                    {/* Direct Browser URL Readout + Copy */}
                    {activeQrUrl && (
                      <div className="mt-3 flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 dark:border-zinc-800 dark:bg-[#11131a]">
                        <span className="truncate font-mono-tabular text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                          {activeQrUrl}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyQrUrl}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#e11d48] hover:underline shrink-0"
                        >
                          {copiedUrl ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                          <span>{copiedUrl ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>
                    )}

                    {qrMode === 'ip' ? (
                      <p className="mt-2 text-center text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        Run <button type="button" onClick={() => setActiveTab('windows')} className="font-semibold text-[#e11d48] hover:underline">Windows Receiver</button> on your laptop — it prints your IP and serves the touch controller directly in your phone browser with zero 403 errors.
                      </p>
                    ) : (
                      <p className="mt-2 text-center text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        Uses the public <span className="font-mono-tabular">ais-pre</span> link instead of the login-locked dev preview. If your phone still sees 403 before sharing the app, switch to <strong>Direct IP (Wi-Fi)</strong>.
                      </p>
                    )}

                    <div className="mt-4 flex w-full items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
                      <div>
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Pairing PIN</div>
                        <div className="font-mono-tabular text-2xl font-bold tracking-[0.18em] text-zinc-950 dark:text-white">
                          {pin || '------'}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={handleCopyPin}
                          className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          aria-label="Copy pairing PIN"
                        >
                          {copiedPin ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onGenerateNewPin()}
                          className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          aria-label="Generate new pairing PIN"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Manual PIN Join */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (pinInput.length >= 4) onPinChange(pinInput);
                    }}
                    className="mt-4 flex gap-2"
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      value={pinInput}
                      onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 12))}
                      placeholder="Join existing PIN"
                      className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 font-mono-tabular text-xs dark:border-zinc-700"
                    />
                    <button
                      type="submit"
                      className="rounded-lg border border-zinc-300 px-3.5 py-2 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 whitespace-nowrap"
                    >
                      Join PIN
                    </button>
                  </form>
                </div>

                {/* Connected Devices List */}
                <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <div className="mb-2.5 flex items-center justify-between text-xs font-semibold">
                    <span>Connected Devices</span>
                    <span className="font-mono-tabular text-zinc-500">
                      {phoneConnected ? 'Phone Online' : 'Waiting for Phone'}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {devices.map((dev) => (
                      <div
                        key={dev.id}
                        className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-[#0c0d13]"
                      >
                        <div className="flex items-center gap-2 truncate">
                          {dev.role === 'phone' ? (
                            <Smartphone className="h-3.5 w-3.5 shrink-0 text-[#e11d48]" />
                          ) : dev.role === 'bridge' ? (
                            <Laptop className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          ) : (
                            <Monitor className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                          )}
                          <span className="truncate font-medium">{dev.name}</span>
                        </div>
                        <span className="ml-2 shrink-0 text-[11px] capitalize text-zinc-500">
                          {dev.platform}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </aside>
            </motion.div>
          )}

          {/* TAB 2: VIGEMBUS GITHUB INTEGRATION & WINDOWS RECEIVER */}
          {activeTab === 'windows' && (
            <motion.div
              key="windows"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 gap-6 lg:grid-cols-12"
            >
              {/* Official ViGEmBus GitHub Repository Release Card */}
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a] lg:col-span-7">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-xs font-semibold text-[#e11d48]">
                      Official Windows Kernel Driver · nefarius/ViGEmBus
                    </div>
                    <h2 className="mt-1 font-display text-xl font-bold">
                      {vigemLoading
                        ? 'Loading ViGEmBus GitHub Release...'
                        : vigemRelease?.name || 'ViGEmBus Driver'}
                    </h2>
                    {vigemRelease && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="font-mono-tabular font-semibold text-zinc-700 dark:text-zinc-200">
                          {vigemRelease.tagName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Published {new Date(vigemRelease.publishedAt).toLocaleDateString()}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>Windows 10 / 11 (x64, x86, ARM64)</span>
                      </div>
                    )}
                  </div>

                  <a
                    href={vigemRelease?.repoUrl || 'https://github.com/nefarius/ViGEmBus'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 whitespace-nowrap"
                  >
                    <span>GitHub Repo</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>

                <p className="mt-4 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
                  ViGEmBus emulates a genuine hardware Xbox 360 controller at the Windows kernel level so GTA V, Minecraft Bedrock, Forza, and every Steam or Game Pass title recognize your iPhone or Android phone natively with full analog triggers and dual sticks.
                </p>

                {/* Primary GitHub Release Download Actions */}
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <a
                    href={
                      vigemRelease?.primaryInstallerUrl ||
                      'https://github.com/nefarius/ViGEmBus/releases'
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-xl bg-[#e11d48] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#be123c]"
                  >
                    <Download className="h-4 w-4" />
                    <span>Download ViGEmBus Setup (.exe)</span>
                  </a>
                  <a
                    href={
                      vigemRelease?.htmlUrl ||
                      'https://github.com/nefarius/ViGEmBus/releases'
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <span>All GitHub Releases</span>
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>

                {/* Release Assets Table */}
                {vigemRelease && vigemRelease.assets.length > 0 && (
                  <div className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800">
                    <h3 className="mb-3 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                      GitHub Release Assets
                    </h3>
                    <div className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                      {vigemRelease.assets.map((asset) => (
                        <div
                          key={asset.name}
                          className="flex items-center justify-between gap-4 px-4 py-3 text-xs"
                        >
                          <div className="truncate font-mono-tabular font-medium">
                            {asset.name}
                          </div>
                          <div className="flex items-center gap-4 shrink-0">
                            <span className="font-mono-tabular text-zinc-500">
                              {formatBytes(asset.size)}
                            </span>
                            <a
                              href={asset.downloadUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-semibold text-[#e11d48] hover:underline"
                            >
                              Download
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Right 5-Col: Upgraded Windows Receiver Bridge & 3-Step Setup */}
              <section className="flex flex-col justify-between gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a] lg:col-span-5">
                <div>
                  <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    Pre-Configured for PIN {pin || '123456'}
                  </div>
                  <h2 className="mt-1 font-display text-xl font-bold">
                    Windows PC Receiver Bridge
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    In the installed Windows desktop app, the bundled BAT and receiver script start automatically when the pairing PIN is ready. Python 3 must be installed; the launcher checks for vgamepad and websockets and installs them on first use. You do not need to run the BAT manually. ViGEmBus must be installed once for virtual Xbox controller output.
                  </p>

                  <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
                    <strong className="text-emerald-700 dark:text-emerald-400">Automatic startup enabled in desktop build 1.0.3+</strong>
                    <div className="mt-1">The BAT launcher receives this app's current PIN and local relay address. The downloads below are manual fallback tools only.</div>
                  </div>

                  <div className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    Manual fallback downloads
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-3">
                    <a
                      href={`/api/download/windows-receiver?pin=${encodeURIComponent(pin)}`}
                      download="redlinepad_windows_receiver.py"
                      className="flex items-center justify-between rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3.5 text-sm font-semibold transition-colors hover:border-[#e11d48] dark:border-zinc-700 dark:bg-[#161923] dark:hover:border-[#e11d48]"
                    >
                      <span className="flex items-center gap-2.5">
                        <Download className="h-4 w-4 text-[#e11d48]" />
                        <span>redlinepad_windows_receiver.py</span>
                      </span>
                      <span className="font-mono-tabular text-xs text-zinc-500">Manual</span>
                    </a>

                    <a
                      href={`/api/download/windows-launcher?pin=${encodeURIComponent(pin)}`}
                      download="Launch_RedlinePad_Windows.bat"
                      className="flex items-center justify-between rounded-xl border border-zinc-300 bg-zinc-50 px-4 py-3.5 text-sm font-semibold transition-colors hover:border-[#e11d48] dark:border-zinc-700 dark:bg-[#161923] dark:hover:border-[#e11d48]"
                    >
                      <span className="flex items-center gap-2.5">
                        <Terminal className="h-4 w-4 text-emerald-500" />
                        <span>Launch_RedlinePad_Windows.bat</span>
                      </span>
                      <span className="font-mono-tabular text-xs text-zinc-500">Fallback</span>
                    </a>
                  </div>

                  {/* Quick Terminal Command */}
                  <div className="mt-5">
                    <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                      <span>Or run manually in Windows Terminal</span>
                      <button
                        type="button"
                        onClick={handleCopyCommand}
                        className="inline-flex items-center gap-1 text-[#e11d48] hover:underline"
                      >
                        {copiedCmd ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <pre className="overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-950 p-3.5 font-mono-tabular text-xs text-zinc-200 dark:border-zinc-800">
                      {bridgeCmd}
                    </pre>
                  </div>
                </div>

                {/* 3-Step Verification Checklist */}
                <ol className="space-y-2.5 border-t border-zinc-200 pt-4 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                  <li className="flex items-start gap-2">
                    <span className="font-mono-tabular font-bold text-[#e11d48]">01.</span>
                    <span>Install the ViGEmBus driver from the GitHub release on the left once, then restart Windows if its installer requests it.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="font-mono-tabular font-bold text-[#e11d48]">02.</span>
                    <span>Open OmniSync Bridge desktop build 1.0.3 or newer. Make sure Python 3 is installed. Its bundled Windows receiver starts automatically using the displayed PIN.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="font-mono-tabular font-bold text-[#e11d48]">03.</span>
                    <span>Connect the phone with PIN {pin}. Confirm the Windows Receiver appears under Connected Devices; test the virtual pad with Win + R, then joy.cpl.</span>
                  </li>
                </ol>
              </section>
            </motion.div>
          )}

          {/* TAB 3: CROSS-PLATFORM SYNC & PROFILES */}
          {activeTab === 'sync' && (
            <motion.div
              key="sync"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 gap-6 lg:grid-cols-12"
            >
              {/* Synced Game Profiles */}
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a] lg:col-span-7">
                <div className="mb-4 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="font-display text-base font-semibold">Synced Game Profiles</h2>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      Selecting or editing a profile immediately updates every paired iOS, Android, and Windows session.
                    </p>
                  </div>
                </div>

                <div className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {settings.profiles.map((profile) => {
                    const isActive = settings.activeProfileId === profile.id;
                    return (
                      <div
                        key={profile.id}
                        className={`flex items-center justify-between gap-3 px-4 py-3.5 transition-colors ${
                          isActive ? 'bg-[#e11d48]/8' : 'hover:bg-zinc-50 dark:hover:bg-[#161923]'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleApplyProfile(profile)}
                          className="flex-1 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-display text-sm font-semibold">
                              {profile.name}
                            </span>
                            {isActive && (
                              <span className="text-[11px] font-semibold text-[#e11d48]">
                                Active
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <span>{LAYOUTS[profile.layout].title}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-tabular">Look {profile.sens.toFixed(1)}x</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-tabular">Gain {profile.gain.toFixed(1)}x</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono-tabular">
                              Deadzone {Math.round(profile.deadzone * 100)}%
                            </span>
                          </div>
                        </button>

                        {settings.profiles.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleDeleteProfile(profile.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-200 hover:text-rose-600 dark:hover:bg-zinc-800"
                            aria-label={`Delete profile ${profile.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Save Current Tuning as New Synced Profile */}
                <form onSubmit={handleCreateProfile} className="mt-4 flex gap-2">
                  <input
                    type="text"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    placeholder="Save current tuning as new profile (e.g. Forza Drift)"
                    className="w-full rounded-lg border border-zinc-300 bg-transparent px-3.5 py-2 text-xs dark:border-zinc-700"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white whitespace-nowrap"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Save Profile</span>
                  </button>
                </form>

                {/* Synced Custom Control Coordinates */}
                <div className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                    Synced Custom Layout Edits
                  </h3>
                  {customLayoutEntries.length === 0 ? (
                    <p className="mt-2 text-xs text-zinc-500">
                      All layouts are currently using factory ergonomic positions. Open Layout Editor on your phone to customize button sizes and positions — they will appear and sync here automatically.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {customLayoutEntries.map(([lid, map]) => (
                        <div
                          key={lid}
                          className="flex items-center justify-between rounded-lg border border-zinc-200 px-3.5 py-2.5 text-xs dark:border-zinc-800"
                        >
                          <div>
                            <span className="font-semibold">
                              {LAYOUTS[lid as LayoutId]?.title || lid}
                            </span>
                            <span className="mx-2 text-zinc-400">·</span>
                            <span className="font-mono-tabular text-zinc-500">
                              {Object.keys(map || {}).length} custom controls synced
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateSettings((prev) => {
                                const next = { ...prev.customLayouts };
                                delete next[lid as LayoutId];
                                return { ...prev, customLayouts: next };
                              })
                            }
                            className="font-semibold text-[#e11d48] hover:underline"
                          >
                            Reset
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Remote Live Tuning Panel */}
              <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a] lg:col-span-5">
                <h2 className="font-display text-base font-semibold">Live Remote Tuning</h2>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Adjust controller ergonomics from your Windows desktop and watch your paired phone update live.
                </p>

                <div className="mt-5 space-y-5">
                  <div>
                    <div className="mb-1.5 flex justify-between text-xs font-semibold">
                      <span>Camera Look Sensitivity</span>
                      <span className="font-mono-tabular text-[#e11d48]">
                        {settings.sens.toFixed(1)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="4"
                      step="0.1"
                      value={settings.sens}
                      onChange={(e) => onUpdateSettings({ sens: parseFloat(e.target.value) })}
                      className="w-full accent-[#e11d48]"
                    />
                  </div>

                  <div>
                    <div className="mb-1.5 flex justify-between text-xs font-semibold">
                      <span>Analog Stick & Steering Gain</span>
                      <span className="font-mono-tabular text-[#e11d48]">
                        {settings.gain.toFixed(1)}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.8"
                      max="2"
                      step="0.1"
                      value={settings.gain}
                      onChange={(e) => onUpdateSettings({ gain: parseFloat(e.target.value) })}
                      className="w-full accent-[#e11d48]"
                    />
                  </div>

                  <div>
                    <div className="mb-1.5 flex justify-between text-xs font-semibold">
                      <span>Thumbstick Deadzone</span>
                      <span className="font-mono-tabular text-[#e11d48]">
                        {Math.round(settings.deadzone * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="0.25"
                      step="0.01"
                      value={settings.deadzone}
                      onChange={(e) => onUpdateSettings({ deadzone: parseFloat(e.target.value) })}
                      className="w-full accent-[#e11d48]"
                    />
                  </div>

                  <div>
                    <div className="mb-2 text-xs font-semibold">Button & Chassis Texture</div>
                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          { id: 'carbon', label: 'Carbon Weave' },
                          { id: 'brushed-metal', label: 'Brushed Metal' },
                          { id: 'ceramic', label: 'Satin Ceramic' },
                        ] as Array<{ id: TextureFinish; label: string }>
                      ).map((tex) => (
                        <button
                          key={tex.id}
                          type="button"
                          onClick={() => onUpdateSettings({ texture: tex.id })}
                          className={`rounded-lg border px-2.5 py-2 text-xs font-semibold transition-colors ${
                            settings.texture === tex.id
                              ? 'border-[#e11d48] bg-[#e11d48]/12 text-[#e11d48]'
                              : 'border-zinc-200 dark:border-zinc-800'
                          }`}
                        >
                          {tex.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3 border-t border-zinc-200 pt-4 text-xs dark:border-zinc-800">
                    <label className="flex items-center justify-between">
                      <span>Haptic Vibration on Touch</span>
                      <input
                        type="checkbox"
                        checked={settings.vib}
                        onChange={(e) => onUpdateSettings({ vib: e.target.checked })}
                        className="h-4 w-4 accent-[#e11d48]"
                      />
                    </label>
                    <label className="flex items-center justify-between">
                      <span>Tactile Mechanical Click Sound (iOS)</span>
                      <input
                        type="checkbox"
                        checked={settings.audioClick}
                        onChange={(e) => onUpdateSettings({ audioClick: e.target.checked })}
                        className="h-4 w-4 accent-[#e11d48]"
                      />
                    </label>
                    <label className="flex items-center justify-between">
                      <span>Minecraft Tap-to-Hit & Hold-to-Mine</span>
                      <input
                        type="checkbox"
                        checked={settings.tap}
                        onChange={(e) => onUpdateSettings({ tap: e.target.checked })}
                        className="h-4 w-4 accent-[#e11d48]"
                      />
                    </label>
                  </div>
                </div>
              </section>
            </motion.div>
          )}

          {/* TAB 4: MULTI-PLATFORM INSTALL (iOS, ANDROID, WINDOWS) */}
          {activeTab === 'install' && (
            <motion.div
              key="install"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-1 gap-6 md:grid-cols-3"
            >
              {/* iOS App */}
              <article className="flex flex-col justify-between rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a]">
                <div>
                  <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                    iPhone & iPad · Safari Standalone App
                  </div>
                  <h2 className="mt-1 font-display text-xl font-bold">iOS Controller App</h2>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Runs edge-to-edge in standalone full-screen mode with synthesized mechanical switch audio feedback and multi-touch pointer capture.
                  </p>
                  <ol className="mt-5 space-y-2.5 text-xs text-zinc-600 dark:text-zinc-300">
                    <li>
                      <strong className="font-mono-tabular text-[#e11d48]">01.</strong> Scan the QR code from the Live Receiver tab in Safari.
                    </li>
                    <li>
                      <strong className="font-mono-tabular text-[#e11d48]">02.</strong> Tap the Safari <strong>Share</strong> button and choose <strong>Add to Home Screen</strong>.
                    </li>
                    <li>
                      <strong className="font-mono-tabular text-[#e11d48]">03.</strong> Launch RedlinePad from your Home Screen and rotate to landscape.
                    </li>
                  </ol>
                </div>
                <button
                  type="button"
                  onClick={onOpenController}
                  className="mt-6 w-full rounded-xl border border-zinc-300 py-2.5 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Preview Mobile Controller
                </button>
              </article>

              {/* Android App */}
              <article className="flex flex-col justify-between rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a]">
                <div>
                  <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    Android · Native Installable PWA
                  </div>
                  <h2 className="mt-1 font-display text-xl font-bold">Android Controller App</h2>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Installs directly to your Android app drawer with full-screen orientation lock, wake-lock screen persistence, and real motor vibration haptics.
                  </p>
                  <ol className="mt-5 space-y-2.5 text-xs text-zinc-600 dark:text-zinc-300">
                    <li>
                      <strong className="font-mono-tabular text-[#e11d48]">01.</strong> Open your paired session URL in Chrome on Android.
                    </li>
                    <li>
                      <strong className="font-mono-tabular text-[#e11d48]">02.</strong> Tap <strong>Install App</strong> inside RedlinePad or Chrome menu.
                    </li>
                    <li>
                      <strong className="font-mono-tabular text-[#e11d48]">03.</strong> Use Cloud Sync Relay anywhere, or switch to Direct Local Wi-Fi for sub-3ms latency.
                    </li>
                  </ol>
                </div>
                <div className="mt-6">
                  {isInstallable ? (
                    <button
                      type="button"
                      onClick={install}
                      className="w-full rounded-xl bg-[#e11d48] py-2.5 text-xs font-semibold text-white hover:bg-[#be123c]"
                    >
                      Install App Now
                    </button>
                  ) : (
                    <div className="flex items-center justify-center gap-2 rounded-xl border border-zinc-200 py-2.5 text-xs font-medium text-zinc-500 dark:border-zinc-800">
                      <ShieldCheck className="h-4 w-4 text-emerald-500" />
                      <span>{isInstalled ? 'Installed as Standalone App' : 'Open on Android Chrome to Install'}</span>
                    </div>
                  )}
                </div>
              </article>

              {/* Windows Desktop App + ViGEmBus */}
              <article className="flex flex-col justify-between rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-[#11131a]">
                <div>
                  <div className="text-xs font-semibold text-[#e11d48]">
                    Windows 10 / 11 · Desktop App + ViGEmBus
                  </div>
                  <h2 className="mt-1 font-display text-xl font-bold">Windows Companion & Driver</h2>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    Install this Desktop Hub directly from Edge or Chrome onto your Windows Start Menu, and run the ViGEmBus Bridge to feed real Xbox 360 & SendInput events into games.
                  </p>
                  <ul className="mt-5 space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
                    <li>· Native XInput Xbox 360 emulation via ViGEmBus</li>
                    <li>· Native SendInput keyboard & mouse camera</li>
                    <li>· Automatic cross-platform profile synchronization</li>
                  </ul>
                </div>
                <div className="mt-6 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('windows')}
                    className="w-full rounded-xl bg-[#e11d48] py-2.5 text-xs font-semibold text-white hover:bg-[#be123c]"
                  >
                    Open ViGEmBus & Driver Downloads
                  </button>
                  {isInstallable && (
                    <button
                      type="button"
                      onClick={install}
                      className="w-full rounded-xl border border-zinc-300 py-2 text-xs font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                    >
                      Install Desktop Window App
                    </button>
                  )}
                </div>
              </article>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};
