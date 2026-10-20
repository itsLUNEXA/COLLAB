import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Task, ModuleIntent } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const TasksScreen: React.FC = () => {
  const { projectId, apiClient } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [intents, setIntents] = useState<ModuleIntent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  const fetchTasksData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);
      const res = await apiClient.getTasks(projectId);
      setTasks(res.tasks);
      setIntents(res.intents);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch tasks and ownership intents');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  useEffect(() => {
    fetchTasksData();
  }, [fetchTasksData]);

  const getTaskStatusBadge = (status: string) => {
    switch (status) {
      case 'DONE':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
      case 'IN_PROGRESS':
        return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20';
      case 'REVIEW':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
      case 'TODO':
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20';
    }
  };

  if (loading && tasks.length === 0 && intents.length === 0) {
    return <LoadingState message="Retrieving active tasks and module ownership intents..." />;
  }

  if (error && tasks.length === 0 && intents.length === 0) {
    return (
      <ErrorState
        title="Tasks & Ownership Error"
        message={error}
        isOffline={isOffline}
        onRetry={fetchTasksData}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">Tasks & Module Ownership</h2>
        <p className="text-sm text-slate-400">
          Exclusive module work leases, coordination intents, and shared project deliverables.
        </p>
      </div>

      {/* Module Ownership Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-500"></span>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Active Module Intents & Leases ({intents.length})
            </h3>
          </div>
          <span className="text-xs text-slate-500">Antigravity Intent Engine</span>
        </div>

        {intents.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-6 text-center text-xs text-slate-400">
            No active module claims. Teammates can claim module intent via MCP tool <code className="text-indigo-300 font-mono">claim_module_intent</code>.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {intents.map((intent) => {
              const expiresDate = new Date(intent.expires_at);
              const isExpired = expiresDate.getTime() < Date.now();

              return (
                <div
                  key={intent.id}
                  className="rounded-2xl border border-indigo-500/30 bg-slate-900/60 p-5 shadow-lg backdrop-blur-sm space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-bold text-white font-mono">
                          {intent.module_name}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                            isExpired
                              ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                              : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                          }`}
                        >
                          {isExpired ? 'EXPIRED' : 'ACTIVE LEASE'}
                        </span>
                      </div>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">
                        Claimed by: {intent.user_id} ({intent.device_id})
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-slate-300 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                    "{intent.intent_description}"
                  </p>

                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 pt-1">
                    <span>Acquired: {new Date(intent.acquired_at).toLocaleTimeString()}</span>
                    <span>Expires: {expiresDate.toLocaleTimeString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Shared Tasks Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider">
              Project Tasks ({tasks.length})
            </h3>
          </div>
        </div>

        {tasks.length === 0 ? (
          <EmptyState
            title="No Tasks Recorded"
            description="No shared backlog tasks are registered for this project yet."
            icon={
              <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg backdrop-blur-sm space-y-3 flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${getTaskStatusBadge(
                        task.status
                      )}`}
                    >
                      {task.status}
                    </span>
                    {task.target_module && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-400 border border-slate-700/60">
                        {task.target_module}
                      </span>
                    )}
                  </div>
                  <h4 className="text-sm font-bold text-white">{task.title}</h4>
                  {task.description && (
                    <p className="text-xs text-slate-400 mt-1 line-clamp-3">{task.description}</p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-800/80 text-[11px] font-mono text-slate-500 flex items-center justify-between">
                  <span>Assigned: {task.assigned_to_user_id || 'Unassigned'}</span>
                  <span>{new Date(task.updated_at).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
