import React from 'react';

interface LoadingStateProps {
  message?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({ message = 'Loading collaborative state...' }) => {
  return (
    <div className="flex flex-col items-center justify-center p-12 space-y-4">
      <div className="relative w-12 h-12">
        <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20 animate-ping" />
        <div className="w-12 h-12 rounded-full border-2 border-transparent border-t-indigo-500 border-r-indigo-400 animate-spin" />
      </div>
      <p className="text-sm font-medium text-slate-400 animate-pulse">{message}</p>
    </div>
  );
};
