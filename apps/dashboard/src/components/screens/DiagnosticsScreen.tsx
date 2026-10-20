import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Diagnostics } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';

export const DiagnosticsScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const fetchDiagnostics = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getDiagnostics(projectId);
      setDiag(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch system diagnostics');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  if (loading && !diag) {
    return <LoadingState message="Executing pre-flight integration diagnostics & health probes..." />;
  }

  if (error && !diag) {
    return (
      <ErrorState
        title="Diagnostics Probe Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchDiagnostics}
      />
    );
  }

  if (!diag) return null;

  const isReady = diag.verification.ready_to_publish;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Integration Settings & System Diagnostics
          </h2>
          <p className="text-sm text-slate-400">
            Pre-flight verification, storage engine status, and gatekeeper readiness criteria.
          </p>
        </div>

        <button
          onClick={fetchDiagnostics}
          className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 font-medium transition-colors self-start sm:self-auto"
        >
          Run Diagnostic Probe
        </button>
      </div>

      {/* Gatekeeper Readiness Hero Banner */}
      <div
        className={`rounded-2xl border p-6 shadow-xl backdrop-blur-sm ${
          isReady
            ? 'bg-emerald-950/20 border-emerald-500/30'
            : 'bg-rose-950/20 border-rose-500/30'
        }`}
      >
        <div className="flex items-center space-x-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-lg ${
              isReady
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
            }`}
          >
            {isReady ? '✓' : '!'}
          </div>
          <div>
            <h3 className="text-base font-bold text-white">
              {isReady ? 'Ready for Publishing' : 'Publishing Gatekeeper Blocked'}
            </h3>
            <p className="text-xs text-slate-300">
              {isReady
                ? 'All integration constraints satisfied. Ready to push to verified integration branch.'
                : 'Blocking conditions detected. Must resolve active conflicts or stale contracts before publishing.'}
            </p>
          </div>
        </div>

        {!isReady && diag.verification.blocking_reasons.length > 0 && (
          <div className="mt-4 p-3 rounded-xl bg-slate-950/60 border border-rose-500/20 space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-rose-400 block">
              Blocking Reasons:
            </span>
            <ul className="list-disc list-inside text-xs text-rose-200 space-y-0.5 font-mono">
              {diag.verification.blocking_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* System Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg">
          <div className="text-xs text-slate-500 font-medium">Storage Engine</div>
          <div className="text-sm font-bold text-white font-mono mt-1">{diag.storage_type}</div>
          <div className="text-[11px] text-slate-400 mt-1">
            {diag.storage_type.includes('Postgres') ? 'Durable PostgreSQL' : 'Fast In-Memory Dev'}
          </div>
        </div>

        <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg">
          <div className="text-xs text-slate-500 font-medium">Current Sync Sequence</div>
          <div className="text-lg font-bold text-indigo-400 font-mono mt-1">#{diag.current_seq_num}</div>
          <div className="text-[11px] text-slate-400 mt-1">Monotonic project order</div>
        </div>

        <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg">
          <div className="text-xs text-slate-500 font-medium">Active Peer Sessions</div>
          <div className="text-lg font-bold text-emerald-400 font-mono mt-1">{diag.connected_peers}</div>
          <div className="text-[11px] text-slate-400 mt-1">Connected WebSocket peers</div>
        </div>

        <div className="p-5 rounded-2xl border border-slate-800 bg-slate-900/60 shadow-lg">
          <div className="text-xs text-slate-500 font-medium">Active Conflicts</div>
          <div className="text-lg font-bold text-rose-400 font-mono mt-1">
            {diag.verification.active_conflicts_count}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Unresolved collisions</div>
        </div>
      </div>

      {/* Diagnostics Details */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl space-y-4">
        <h3 className="text-sm font-bold text-white">Diagnostics Information</h3>
        <div className="space-y-2 text-xs font-mono">
          <div className="flex justify-between py-2 border-b border-slate-800">
            <span className="text-slate-400 font-sans">Project Identifier:</span>
            <span className="text-slate-200">{diag.project_id}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-slate-800">
            <span className="text-slate-400 font-sans">Server Timestamp:</span>
            <span className="text-slate-200">{new Date(diag.server_time).toLocaleString()}</span>
          </div>
          <div className="flex justify-between py-2 border-b border-slate-800">
            <span className="text-slate-400 font-sans">Stale Consumers Count:</span>
            <span className="text-amber-400 font-bold">{diag.verification.stale_consumers.length}</span>
          </div>
          <div className="flex justify-between py-2">
            <span className="text-slate-400 font-sans">Latest Checkpoint:</span>
            <span className="text-slate-200">
              {diag.verification.latest_checkpoint
                ? `${diag.verification.latest_checkpoint.kind} (${diag.verification.latest_checkpoint.status})`
                : 'None created yet'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
