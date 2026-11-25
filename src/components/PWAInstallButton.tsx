import React, { useState } from 'react';
import { Download, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
  className = '',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={`inline-flex items-center justify-center gap-2 rounded-lg bg-[#e11d48] px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#be123c] active:scale-[0.98] whitespace-nowrap shrink-0 ${className}`}
      >
        <Download className="h-3.5 w-3.5" />
        <span>{compact ? 'Install' : 'Install App'}</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className={`inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-xs font-semibold text-zinc-800 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap shrink-0 ${className}`}
        >
          <Smartphone className="h-3.5 w-3.5" />
          <span>{compact ? 'iOS App' : 'Install on iOS'}</span>
        </button>

        <AnimatePresence>
          {showIOSGuide && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
              onClick={() => setShowIOSGuide(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 10 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-900 shadow-2xl dark:border-zinc-800 dark:bg-[#12141a] dark:text-zinc-100"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-lg font-semibold">Install on iPhone or iPad</h3>
                  <button
                    type="button"
                    onClick={() => setShowIOSGuide(false)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    aria-label="Close iOS install instructions"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                  Add RedlinePad to your Home Screen for full-screen landscape gaming without Safari toolbars.
                </p>
                <ol className="mt-4 space-y-3 text-sm text-zinc-800 dark:text-zinc-200">
                  <li className="flex items-start gap-2.5">
                    <span className="font-mono-tabular font-semibold text-[#e11d48]">01.</span>
                    <span>
                      Tap the <Share className="mx-1 inline h-3.5 w-3.5 text-[#e11d48]" />
                      <strong>Share</strong> icon in Safari.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="font-mono-tabular font-semibold text-[#e11d48]">02.</span>
                    <span>
                      Scroll down and select <strong>Add to Home Screen</strong>.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="font-mono-tabular font-semibold text-[#e11d48]">03.</span>
                    <span>
                      Launch <strong>RedlinePad</strong> directly from your Home Screen.
                    </span>
                  </li>
                </ol>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="mt-6 w-full rounded-xl bg-zinc-900 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white"
                >
                  Done
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/90 px-3.5 py-2 text-xs font-medium text-amber-200 shadow-lg backdrop-blur-md">
      <WifiOff className="h-3.5 w-3.5 text-amber-400" />
      <span>Offline Mode — Cached layouts and Direct LAN remain available</span>
    </div>
  );
};
