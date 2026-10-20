import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { ActiveConflict } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const ConflictsScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [conflicts, setConflicts] = useState<ActiveConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolutionNotice, setResolutionNotice] = useState<string | null>(null);

  const fetchConflicts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getConflicts(projectId);
      setConflicts(res.conflicts);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch conflicts');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  useEffect(() => {
    fetchConflicts();
  }, [fetchConflicts]);

  const handleResolve = async (
    conflictId: string,
    resolution: 'RESOLVED_KEEP_LOCAL' | 'RESOLVED_ACCEPT_REMOTE' | 'RESOLVED_MERGED',
    resolvedContent?: string
  ) => {
    try {
      setResolvingId(conflictId);
      setResolutionNotice(null);
      await apiClient.resolveConflict(projectId, conflictId, resolution, resolvedContent);
      setResolutionNotice(`Conflict successfully resolved with ${resolution}. Broadcasted to peers.`);
      await fetchConflicts();
    } catch (err: any) {
      alert(`Resolution failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setResolvingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'DETECTED':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'UNDER_REVIEW':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'RESOLVED_KEEP_LOCAL':
      case 'RESOLVED_ACCEPT_REMOTE':
      case 'RESOLVED_MERGED':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
  };

  if (loading && conflicts.length === 0) {
    return <LoadingState message="Auditing active workspace conflicts & three-way merge state..." />;
  }

  if (error && conflicts.length === 0) {
    return (
      <ErrorState
        title="Conflict Monitor Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchConflicts}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Active Conflicts & Resolution Status</h2>
          <p className="text-sm text-slate-400">
            Three-way merge arbitration, isolation buffers, and peer broadcast state.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <span className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 font-mono">
            Active Conflicts: <span className="font-bold text-rose-400">{conflicts.length}</span>
          </span>
        </div>
      </div>

      {resolutionNotice && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
          <span>{resolutionNotice}</span>
          <button
            onClick={() => setResolutionNotice(null)}
            className="text-emerald-400 hover:text-emerald-200 font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {conflicts.length === 0 ? (
        <EmptyState
          title="No Conflicts Detected"
          description="All concurrent edits have synchronized cleanly without overlapping collisions. The workspace is fully consistent."
          icon={
            <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 13l4 4L19 7" />
            </svg>
          }
        />
      ) : (
        <div className="space-y-4">
          {conflicts.map((conflict) => {
            const isResolved = conflict.conflict_status.startsWith('RESOLVED');
            const isProcessing = resolvingId === conflict.id;

            return (
              <div
                key={conflict.id}
                className="rounded-2xl border border-rose-500/20 bg-slate-900/60 p-6 shadow-xl backdrop-blur-sm space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-3">
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-mono text-sm font-bold text-white">
                        {conflict.relative_path}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${getStatusBadge(
                          conflict.conflict_status
                        )}`}
                      >
                        {conflict.conflict_status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono mt-1">
                      Conflict ID: {conflict.id} (Seq #{conflict.server_seq})
                    </div>
                  </div>

                  <div className="text-xs text-slate-400 font-mono">
                    Detected: {new Date(conflict.created_at).toLocaleTimeString()}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                  <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1">
                    <span className="text-slate-500 block text-[11px] font-sans">Local Device (A)</span>
                    <div className="text-slate-200 truncate">{conflict.device_a_id}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      Base Hash: {conflict.base_hash ? conflict.base_hash.slice(0, 12) + '...' : 'None (Created)'}
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1">
                    <span className="text-slate-500 block text-[11px] font-sans">Remote Incoming (B)</span>
                    <div className="text-slate-200 truncate">{conflict.device_b_id}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      Remote Hash: {conflict.remote_hash.slice(0, 12)}...
                    </div>
                  </div>
                </div>

                {/* Resolution Action Toolbar */}
                {!isResolved && (
                  <div className="pt-2 flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => handleResolve(conflict.id, 'RESOLVED_KEEP_LOCAL')}
                      disabled={isProcessing}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {isProcessing ? 'Resolving...' : 'Keep Local Version'}
                    </button>

                    <button
                      onClick={() => handleResolve(conflict.id, 'RESOLVED_ACCEPT_REMOTE')}
                      disabled={isProcessing}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      Accept Remote Version
                    </button>

                    <button
                      onClick={() => {
                        const content = prompt(
                          'Enter resolved manual merge content for ' + conflict.relative_path
                        );
                        if (content !== null) {
                          handleResolve(conflict.id, 'RESOLVED_MERGED', content);
                        }
                      }}
                      disabled={isProcessing}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      Manual Merge Payload...
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
