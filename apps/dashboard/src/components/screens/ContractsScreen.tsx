import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { IntegrationContract } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const ContractsScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [contracts, setContracts] = useState<IntegrationContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const fetchContracts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getContracts(projectId);
      setContracts(res.contracts);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch API contracts');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  useEffect(() => {
    fetchContracts();
  }, [fetchContracts]);

  // Find all consumers across all contracts that are currently stale
  const staleConsumers = useMemo(() => {
    const list: Array<{
      contractId: string;
      identifier: string;
      consumer: string;
      reason: string;
    }> = [];
    for (const c of contracts) {
      for (const cons of c.consumers || []) {
        if (cons.is_stale) {
          list.push({
            contractId: c.id,
            identifier: c.identifier,
            consumer: cons.consumer_module,
            reason: cons.stale_reason || 'Contract updated without consumer reverification',
          });
        }
      }
    }
    return list;
  }, [contracts]);

  if (loading && contracts.length === 0) {
    return <LoadingState message="Inspecting API contracts, schema hashes & consumer staleness..." />;
  }

  if (error && contracts.length === 0) {
    return (
      <ErrorState
        title="Contract Guard Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchContracts}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">
          API Contracts, Stale Warnings & Shared AI Context
        </h2>
        <p className="text-sm text-slate-400">
          Authoritative contracts, breaking change detection, and cross-module dependency guards.
        </p>
      </div>

      {/* Stale Warning Banner */}
      {staleConsumers.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-5 space-y-3">
          <div className="flex items-center space-x-2.5 text-amber-300">
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <h3 className="text-sm font-bold uppercase tracking-wide">
              {staleConsumers.length} Consumer Module{staleConsumers.length > 1 ? 's' : ''} Outdated
            </h3>
          </div>
          <div className="space-y-2 text-xs">
            {staleConsumers.map((item, idx) => (
              <div
                key={idx}
                className="p-3 rounded-xl bg-slate-950/60 border border-amber-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div>
                  <span className="font-semibold text-white">Module '{item.consumer}'</span>{' '}
                  <span className="text-slate-400">is consuming stale contract</span>{' '}
                  <span className="font-mono text-amber-300 font-bold">{item.identifier}</span>
                  <div className="text-[11px] text-amber-400/80 mt-0.5">{item.reason}</div>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 self-start sm:self-auto">
                  STALE
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {contracts.length === 0 ? (
        <EmptyState
          title="No Contracts Registered"
          description="Publish your first OpenAPI or TypeScript interface contract via the Antigravity MCP tool `publish_api_contract` to enforce integration safeguards."
          icon={
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {contracts.map((contract) => (
            <div
              key={contract.id}
              className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl backdrop-blur-sm space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-2">
                <div>
                  <div className="flex items-center space-x-3">
                    <span className="text-base font-bold text-white font-mono">
                      {contract.identifier}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                      v{contract.current_version}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {contract.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 font-mono mt-1">
                    Owner Module: <span className="text-slate-200">{contract.owner_module}</span> | Type:{' '}
                    <span className="text-slate-200">{contract.contract_type}</span>
                  </div>
                </div>

                <div className="text-[11px] font-mono text-slate-500 truncate max-w-[200px]" title={contract.current_schema_hash}>
                  Hash: {contract.current_schema_hash.slice(0, 16)}...
                </div>
              </div>

              {/* Consumers list */}
              <div>
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Registered Consumer Modules ({contract.consumers?.length || 0})
                </h4>

                {(!contract.consumers || contract.consumers.length === 0) ? (
                  <p className="text-xs text-slate-500 italic">No consumer modules have registered a dependency yet.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {contract.consumers.map((c, i) => (
                      <div
                        key={i}
                        className={`p-3 rounded-xl border text-xs ${
                          c.is_stale
                            ? 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                            : 'bg-slate-950/50 border-slate-800 text-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-between font-semibold">
                          <span>{c.consumer_module}</span>
                          <span
                            className={`px-1.5 py-0.2 rounded text-[10px] font-mono ${
                              c.is_stale ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'
                            }`}
                          >
                            {c.is_stale ? 'STALE' : 'COMPLIANT'}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1 font-mono">
                          Verified v{c.last_verified_version}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
