import React from 'react';

export type ScreenId =
  | 'projects'
  | 'devices'
  | 'activity'
  | 'conflicts'
  | 'contracts'
  | 'tasks'
  | 'checkpoints'
  | 'diagnostics';

interface SidebarProps {
  currentScreen: ScreenId;
  onSelectScreen: (screen: ScreenId) => void;
  badgeCounts?: {
    conflicts?: number;
    staleContracts?: number;
    onlineDevices?: number;
  };
}

interface NavItem {
  id: ScreenId;
  label: string;
  icon: (active: boolean) => React.ReactNode;
  badgeKey?: 'conflicts' | 'staleContracts' | 'onlineDevices';
  badgeColor?: string;
}

const navItems: NavItem[] = [
  {
    id: 'projects',
    label: 'Projects & Team',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
      </svg>
    ),
  },
  {
    id: 'devices',
    label: 'Connected Devices',
    badgeKey: 'onlineDevices',
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Recent Changes',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'conflicts',
    label: 'Conflicts & Merge',
    badgeKey: 'conflicts',
    badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    id: 'contracts',
    label: 'Contracts & AI Context',
    badgeKey: 'staleContracts',
    badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'tasks',
    label: 'Tasks & Ownership',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    id: 'checkpoints',
    label: 'GitHub Checkpoints',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics & Health',
    icon: (active) => (
      <svg className={`w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

export const Sidebar: React.FC<SidebarProps> = ({
  currentScreen,
  onSelectScreen,
  badgeCounts = {},
}) => {
  return (
    <aside className="w-64 border-r border-slate-800 bg-slate-900/40 p-4 flex flex-col justify-between shrink-0">
      <div className="space-y-1">
        <div className="px-3 pb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Navigation
        </div>
        {navItems.map((item) => {
          const isActive = currentScreen === item.id;
          const badgeCount = item.badgeKey ? badgeCounts[item.badgeKey] ?? 0 : 0;

          return (
            <button
              key={item.id}
              onClick={() => onSelectScreen(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                isActive
                  ? 'bg-indigo-600/15 text-indigo-300 border border-indigo-500/30 font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 border border-transparent'
              }`}
            >
              <div className="flex items-center space-x-3">
                {item.icon(isActive)}
                <span>{item.label}</span>
              </div>
              {badgeCount > 0 && (
                <span
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-bold rounded-md border ${
                    item.badgeColor || 'bg-slate-800 text-slate-300 border-slate-700'
                  }`}
                >
                  {badgeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="pt-4 border-t border-slate-800 text-[11px] text-slate-500 px-3 space-y-1">
        <div className="flex items-center justify-between">
          <span>Engine</span>
          <span className="font-mono text-slate-400">Antigravity 2.0</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Dashboard</span>
          <span className="text-emerald-400 font-medium">Phase 6 Active</span>
        </div>
      </div>
    </aside>
  );
};
