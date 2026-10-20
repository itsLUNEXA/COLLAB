import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Checkpoint } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const CheckpointsScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [selectedKind, setSelectedKind] = useState<string>('ALL');

  const fetchCheckpoints = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getCheckpoints(
        projectId,
        selectedKind === 'ALL' ? undefined : selectedKind
      );
      setCheckpoints(res.checkpoints);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch checkpoints');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient, selectedKind]);

  useEffect(() => {
    fetchCheckpoints();
  }, [fetchCheckpoints]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PUBLISHED':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'PASSED':
        return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
      case 'FAILED':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'RUNNING_CHECKS':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'PENDING':
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
  };

  const getKindBadge = (kind: string) => {
    switch (kind) {
      case 'VERIFIED_INTEGRATION':
        return 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30';
      case 'WIP_SNAPSHOT':
      default:
        return 'bg-slate-800 text-slate-300 border-slate-700';
    }
  };

  if (loading && checkpoints.length === 0) {
    return <LoadingState message="Querying GitHub checkpoints & immutable snapshot audit trail..." />;
  }

  if (error && checkpoints.length === 0) {
    return (
      <ErrorState
        title="Checkpoints Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchCheckpoints}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">
            GitHub Checkpoints & Publishing Status
          </h2>
          <p className="text-sm text-slate-400">
            Immutable snapshot verification, validation reports, and atomic branch publishing.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <select
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value)}
            className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
          >
            <option value="ALL">All Checkpoints</option>
            <option value="WIP_SNAPSHOT">WIP Snapshots</option>
            <option value="VERIFIED_INTEGRATION">Verified Integration</option>
          </select>
        </div>
      </div>

      {checkpoints.length === 0 ? (
        <EmptyState
          title="No Checkpoints Recorded"
          description="Create a continuous WIP snapshot or verified integration checkpoint through the companion or server API."
          icon={
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
            </svg>
          }
        />
      ) : (
        <div className="space-y-4">
          {checkpoints.map((cp) => {
            const report = cp.validation_report;

            return (
              <div
                key={cp.id}
                className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl backdrop-blur-sm space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-3">
                  <div>
                    <div className="flex items-center space-x-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${getKindBadge(cp.kind)}`}>
                        {cp.kind === 'VERIFIED_INTEGRATION' ? 'VERIFIED RELEASE' : 'WIP SNAPSHOT'}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${getStatusBadge(cp.status)}`}>
                        {cp.status}
                      </span>
                      <span className="text-xs text-slate-400 font-mono">
                        Seq #{cp.sync_sequence_num}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 font-mono mt-1">
                      ID: {cp.id}
                    </div>
                  </div>

                  <div className="text-xs text-slate-500 font-mono">
                    {new Date(cp.created_at).toLocaleString()}
                  </div>
                </div>

                {/* Metadata Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
                  <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
                    <span className="text-slate-500 block text-[11px] font-sans">Tree Hash</span>
                    <span className="text-slate-200 truncate block" title={cp.tree_sha256}>
                      {cp.tree_sha256.slice(0, 16)}...
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
                    <span className="text-slate-500 block text-[11px] font-sans">Target Branch</span>
                    <span className="text-indigo-300 font-semibold block">
                      {cp.github_target_branch || 'Not Assigned'}
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
                    <span className="text-slate-500 block text-[11px] font-sans">GitHub Commit SHA</span>
                    <span className="text-emerald-400 font-semibold block truncate">
                      {cp.github_commit_sha ? cp.github_commit_sha.slice(0, 12) : 'Unpublished'}
                    </span>
                  </div>
                </div>

                {/* Validation Report Card */}
                {report && (
                  <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-300">Pre-Publish Validation Checks:</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          report.passed
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-rose-500/20 text-rose-300'
                        }`}
                      >
                        {report.passed ? 'ALL CHECKS PASSED' : 'VALIDATION FAILED'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] font-mono pt-1">
                      <div className="flex items-center space-x-1.5 text-slate-400">
                        <span>{report.typecheck_passed ? '✓' : '✗'}</span>
                        <span>Typecheck</span>
                      </div>
                      <div className="flex items-center space-x-1.5 text-slate-400">
                        <span>{report.contracts_conformance_passed ? '✓' : '✗'}</span>
                        <span>Contracts Conformance</span>
                      </div>
                      <div className="flex items-center space-x-1.5 text-slate-400">
                        <span>{!report.has_unresolved_conflicts ? '✓' : '✗'}</span>
                        <span>Conflict Free</span>
                      </div>
                    </div>

                    {report.issues && report.issues.length > 0 && (
                      <div className="mt-2 space-y-1 border-t border-slate-800 pt-2">
                        {report.issues.map((iss, i) => (
                          <div key={i} className="text-rose-400 text-[11px]">
                            [{iss.severity}] {iss.message} {iss.file_path ? `(${iss.file_path})` : ''}
                          </div>
                        ))}
                      </div>
                    )}
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
