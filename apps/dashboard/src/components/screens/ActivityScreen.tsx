import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import { SyncEventItem } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const ActivityScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [events, setEvents] = useState<SyncEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [selectedOp, setSelectedOp] = useState<string>('ALL');

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getEvents(projectId, 0, 100);
      // Present in reverse chronological order (latest sequence first)
      setEvents(res.events.slice().reverse());
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch activity stream');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      const matchesSearch =
        ev.relative_path.toLowerCase().includes(filterText.toLowerCase()) ||
        ev.device_id.toLowerCase().includes(filterText.toLowerCase()) ||
        ev.client_op_id.toLowerCase().includes(filterText.toLowerCase());

      const matchesOp = selectedOp === 'ALL' || ev.op_type === selectedOp;

      return matchesSearch && matchesOp;
    });
  }, [events, filterText, selectedOp]);

  const getOpBadge = (op: string) => {
    switch (op) {
      case 'FILE_CREATE':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'FILE_UPDATE':
        return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
      case 'FILE_DELETE':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
      case 'FILE_RENAME':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    }
  };

  if (loading && events.length === 0) {
    return <LoadingState message="Fetching live file change audit stream..." />;
  }

  if (error && events.length === 0) {
    return (
      <ErrorState
        title="Activity Stream Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchEvents}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Recent File Changes & Activity</h2>
          <p className="text-sm text-slate-400">
            Monotonically sequenced synchronization events persisted by the collaboration hub.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter by path or device..."
            className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-48 sm:w-64"
          />

          <select
            value={selectedOp}
            onChange={(e) => setSelectedOp(e.target.value)}
            className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
          >
            <option value="ALL">All Ops</option>
            <option value="FILE_CREATE">Create</option>
            <option value="FILE_UPDATE">Update</option>
            <option value="FILE_DELETE">Delete</option>
            <option value="FILE_RENAME">Rename</option>
          </select>
        </div>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="No File Changes Yet"
          description="No file-change events have been synchronized for this project. Save a file in your workspace to trigger the first sync event."
          icon={
            <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      ) : filteredEvents.length === 0 ? (
        <EmptyState
          title="No Matching Events"
          description="No synchronization events match the current filter criteria."
          actionText="Clear Filters"
          onAction={() => {
            setFilterText('');
            setSelectedOp('ALL');
          }}
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 shadow-xl backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] tracking-wider font-semibold border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">Seq</th>
                  <th className="py-3 px-4">Op Type</th>
                  <th className="py-3 px-4">File Path</th>
                  <th className="py-3 px-4">Origin Device</th>
                  <th className="py-3 px-4">Target Hash</th>
                  <th className="py-3 px-4 text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filteredEvents.map((ev) => (
                  <tr key={`${ev.seq_num}-${ev.client_op_id}`} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-indigo-400">
                      #{ev.seq_num}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${getOpBadge(ev.op_type)}`}>
                        {ev.op_type}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-200">
                      {ev.relative_path}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-400 truncate max-w-[140px]" title={ev.device_id}>
                      {ev.device_id}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-400 text-[11px] truncate max-w-[120px]" title={ev.target_hash}>
                      {ev.target_hash.slice(0, 10)}...
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-slate-500 whitespace-nowrap">
                      {new Date(ev.created_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
