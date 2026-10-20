import React, { useState, useEffect, useCallback } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Header } from './components/common/Header';
import { Sidebar, ScreenId } from './components/common/Sidebar';
import { OfflineBanner } from './components/common/OfflineBanner';
import { ProjectsScreen } from './components/screens/ProjectsScreen';
import { DevicesScreen } from './components/screens/DevicesScreen';
import { ActivityScreen } from './components/screens/ActivityScreen';
import { ConflictsScreen } from './components/screens/ConflictsScreen';
import { ContractsScreen } from './components/screens/ContractsScreen';
import { TasksScreen } from './components/screens/TasksScreen';
import { CheckpointsScreen } from './components/screens/CheckpointsScreen';
import { DiagnosticsScreen } from './components/screens/DiagnosticsScreen';

const DashboardContent: React.FC = () => {
  const { projectId, apiClient, isOnline } = useAuth();
  const [currentScreen, setCurrentScreen] = useState<ScreenId>('projects');
  const [currentSeqNum, setCurrentSeqNum] = useState<number>(0);
  const [badgeCounts, setBadgeCounts] = useState<{
    conflicts?: number;
    staleContracts?: number;
    onlineDevices?: number;
  }>({});
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshSummary = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const [devicesRes, conflictsRes, contractsRes] = await Promise.allSettled([
        apiClient.getDevices(projectId),
        apiClient.getConflicts(projectId),
        apiClient.getContracts(projectId),
      ]);

      let seq = currentSeqNum;
      let onlineDevices = 0;
      let conflictCount = 0;
      let staleCount = 0;

      if (devicesRes.status === 'fulfilled') {
        seq = devicesRes.value.current_seq_num;
        onlineDevices = devicesRes.value.connected_count;
      }
      if (conflictsRes.status === 'fulfilled') {
        conflictCount = conflictsRes.value.conflicts.filter(
          (c) => !c.conflict_status.startsWith('RESOLVED')
        ).length;
      }
      if (contractsRes.status === 'fulfilled') {
        for (const c of contractsRes.value.contracts) {
          for (const cons of c.consumers || []) {
            if (cons.is_stale) staleCount++;
          }
        }
      }

      setCurrentSeqNum(seq);
      setBadgeCounts({
        onlineDevices,
        conflicts: conflictCount,
        staleContracts: staleCount,
      });
    } catch {
      // Ignore background refresh errors
    } finally {
      setIsRefreshing(false);
    }
  }, [projectId, apiClient, currentSeqNum]);

  useEffect(() => {
    refreshSummary();
    const interval = setInterval(refreshSummary, 10000);
    return () => clearInterval(interval);
  }, [refreshSummary]);

  const renderScreen = () => {
    switch (currentScreen) {
      case 'projects':
        return <ProjectsScreen />;
      case 'devices':
        return <DevicesScreen />;
      case 'activity':
        return <ActivityScreen />;
      case 'conflicts':
        return <ConflictsScreen />;
      case 'contracts':
        return <ContractsScreen />;
      case 'tasks':
        return <TasksScreen />;
      case 'checkpoints':
        return <CheckpointsScreen />;
      case 'diagnostics':
        return <DiagnosticsScreen />;
      default:
        return <ProjectsScreen />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      <Header
        currentSeqNum={currentSeqNum}
        onRefresh={refreshSummary}
        isRefreshing={isRefreshing}
      />
      <OfflineBanner isOnline={isOnline} />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          currentScreen={currentScreen}
          onSelectScreen={setCurrentScreen}
          badgeCounts={badgeCounts}
        />

        <main className="flex-1 overflow-y-auto p-6 lg:p-8 bg-gradient-to-b from-slate-950 via-slate-900/40 to-slate-950">
          <div className="max-w-6xl mx-auto">{renderScreen()}</div>
        </main>
      </div>
    </div>
  );
};

interface ErrorBoundaryProps {
  children: React.ReactNode;
}
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Unhandled dashboard rendering error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-red-500/30 rounded-xl p-8 max-w-lg w-full text-center space-y-4 shadow-2xl">
            <div className="w-12 h-12 rounded-full bg-red-500/10 text-red-400 mx-auto flex items-center justify-center font-bold text-xl">
              !
            </div>
            <h2 className="text-xl font-bold text-white">Dashboard Encountered an Error</h2>
            <p className="text-xs text-red-300 font-mono bg-red-950/40 p-3 rounded border border-red-900/50 break-words">
              {this.state.error?.message || 'Unknown render failure'}
            </p>
            <button
              onClick={() => {
                localStorage.removeItem('collab_token');
                window.location.reload();
              }}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium text-sm transition"
            >
              Reset Session & Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <DashboardContent />
      </AuthProvider>
    </ErrorBoundary>
  );
};

export default App;
