import React from 'react';

interface OfflineBannerProps {
  isOnline: boolean;
}

export const OfflineBanner: React.FC<OfflineBannerProps> = ({ isOnline }) => {
  if (isOnline) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5 text-center text-xs font-medium text-amber-300 flex items-center justify-center space-x-2">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
      </span>
      <span>
        You are currently <strong>Offline</strong>. Displaying cached dashboard state. Live synchronization is paused until connection is restored.
      </span>
    </div>
  );
};
