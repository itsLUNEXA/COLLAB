import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';

interface HeaderProps {
  currentSeqNum?: number;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  currentSeqNum = 0,
  onRefresh,
  isRefreshing = false,
}) => {
  const {
    projectId,
    setProjectId,
    token,
    setToken,
    userId,
    setUserId,
    deviceId,
    setDeviceId,
    isOnline,
    isDev,
    generateDevToken,
    authError,
  } = useAuth();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [tempProjectId, setTempProjectId] = useState(projectId);
  const [tempToken, setTempToken] = useState(token);
  const [tempUserId, setTempUserId] = useState(userId);
  const [tempDeviceId, setTempDeviceId] = useState(deviceId);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleOpenModal = () => {
    setTempProjectId(projectId);
    setTempToken(token);
    setTempUserId(userId);
    setTempDeviceId(deviceId);
    setIsModalOpen(true);
  };

  const handleSaveModal = () => {
    setProjectId(tempProjectId.trim());
    setToken(tempToken.trim());
    setUserId(tempUserId.trim());
    setDeviceId(tempDeviceId.trim());
    setIsModalOpen(false);
    if (onRefresh) onRefresh();
  };

  const handleGenerateDevToken = async () => {
    try {
      setIsGenerating(true);
      const generated = await generateDevToken();
      setTempToken(generated);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <>
      <header className="h-16 border-b border-slate-800 bg-slate-900/60 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-cyan-400 flex items-center justify-center font-bold text-white shadow-md shadow-indigo-500/20">
            C
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-wide flex items-center space-x-2">
              <span>Collab Hub</span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                Phase 6
              </span>
            </h1>
            <p className="text-[11px] text-slate-400 font-mono truncate max-w-[220px]" title={projectId}>
              {projectId}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Live Sync Status */}
          <div
            className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-xs"
            title={!isOnline ? 'Offline: No network connection' : authError ? `Auth Error: ${authError}` : 'Online: Connected to Collab Hub'}
          >
            <span className="relative flex h-2 w-2">
              {!isOnline ? (
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
              ) : authError ? (
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              ) : (
                <>
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </>
              )}
            </span>
            <span
              className={
                !isOnline
                  ? 'text-rose-400 font-medium'
                  : authError
                  ? 'text-amber-400 font-medium'
                  : 'text-emerald-400 font-medium'
              }
            >
              {!isOnline ? 'Offline' : authError ? 'Auth Error' : 'Online'}
            </span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400 font-mono">Seq #{currentSeqNum}</span>
          </div>

          {/* Refresh Button */}
          {onRefresh && (
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              title="Refresh Dashboard"
              className={`p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors ${
                isRefreshing ? 'animate-spin text-indigo-400' : ''
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          )}

          {/* Settings / Auth Modal Button */}
          <button
            onClick={handleOpenModal}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>Config</span>
          </button>
        </div>
      </header>

      {/* Auth / Settings Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-semibold text-white">Connection & Authentication Settings</h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-300 mb-1">Target Project ID</label>
                <input
                  type="text"
                  value={tempProjectId}
                  onChange={(e) => setTempProjectId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  placeholder="UUID (e.g. 11111111-1111-4111-8111-111111111111)"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-300 mb-1">User ID</label>
                  <input
                    type="text"
                    value={tempUserId}
                    onChange={(e) => setTempUserId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-300 mb-1">Device ID</label>
                  <input
                    type="text"
                    value={tempDeviceId}
                    onChange={(e) => setTempDeviceId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-slate-300">Session JWT Token (Bearer)</label>
                  {isDev && (
                    <button
                      onClick={handleGenerateDevToken}
                      disabled={isGenerating}
                      className="text-indigo-400 hover:text-indigo-300 font-medium text-[11px] underline"
                    >
                      {isGenerating ? 'Generating...' : 'Auto-Generate Dev Token'}
                    </button>
                  )}
                </div>
                <textarea
                  rows={3}
                  value={tempToken}
                  onChange={(e) => setTempToken(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-indigo-500"
                  placeholder="Paste or auto-generate HS256 JWT..."
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-3 border-t border-slate-800">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveModal}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md transition-colors"
              >
                Save & Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
