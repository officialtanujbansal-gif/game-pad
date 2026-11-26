export {};

declare global {
  interface Window {
    omniSyncBridge?: {
      setPairingPin(pin: string): Promise<{
        started: boolean;
        alreadyRunning?: boolean;
        reason?: string;
      }>;
    };
  }
}
