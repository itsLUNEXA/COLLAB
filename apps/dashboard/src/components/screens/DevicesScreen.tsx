import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { DeviceSession } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const DevicesScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [currentSeq, setCurrentSeq] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getDevices(projectId);
      setDevices(res.devices);
      setCurrentSeq(res.current_seq_num);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch connected devices');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  useEffect(() => {
    fetchDevices();
    const interval = setInterval(fetchDevices, 5000); // Polling every 5s for live status
    return () => clearInterval(interval);
  }, [fetchDevices]);

  if (loading && devices.length === 0) {
    return <LoadingState message="Discovering connected devices & live sessions..." />;
  }

  if (error && devices.length === 0) {
    return (
      <ErrorState
        title="Device Status Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchDevices}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Connected Devices & Live Sync</h2>
          <p className="text-sm text-slate-400">
            Real-time peer presence, heartbeat monitoring, and synchronization sequence status.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <div className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 font-mono">
            Current Sequence: <span className="text-indigo-400 font-bold">#{currentSeq}</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300 font-medium">
            Active Peers: <span className="font-bold">{devices.length}</span>
          </div>
        </div>
      </div>

      {devices.length === 0 ? (
        <EmptyState
          title="No Active Devices"
          description="There are currently no companion clients connected to this project gateway. Launch the desktop companion or Antigravity IDE to join."
          icon={
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {devices.map((device) => {
            const lastPingSecondsAgo = Math.max(
              0,
              Math.floor((Date.now() - new Date(device.last_heartbeat).getTime()) / 1000)
            );

            return (
              <div
                key={device.device_id}
                className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg backdrop-blur-sm space-y-4 hover:border-slate-700 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                    <div>
                      <div className="text-sm font-bold text-white font-mono">{device.device_id}</div>
                      <div className="text-xs text-slate-400 font-mono">User: {device.user_id}</div>
                    </div>
                  </div>

                  <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>ONLINE</span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800/80 text-xs">
                  <div>
                    <span className="text-slate-500 block text-[11px]">Connected At</span>
                    <span className="font-mono text-slate-300">
                      {new Date(device.connected_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[11px]">Last Heartbeat</span>
                    <span className="font-mono text-slate-300">
                      {lastPingSecondsAgo < 3 ? 'Just now' : `${lastPingSecondsAgo}s ago`}
                    </span>
                  </div>
                </div>

                <div className="pt-2 text-[11px] text-slate-400 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/60 flex items-center justify-between">
                  <span>Transport Protocol:</span>
                  <span className="font-mono text-indigo-400">WebSocket (v2.0)</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
