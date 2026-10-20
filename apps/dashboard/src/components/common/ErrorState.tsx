import React from 'react';

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  isOffline?: boolean;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'Failed to load data',
  message,
  onRetry,
  isOffline = false,
}) => {
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 p-6 my-4 shadow-sm">
      <div className="flex items-start space-x-3">
        <div className="flex-shrink-0 mt-0.5">
          {isOffline ? (
            <svg
              className="w-5 h-5 text-amber-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 4.243a9 9 0 01-1.414-1.414M3 3l18 18"
              />
            </svg>
          ) : (
            <svg
              className="w-5 h-5 text-rose-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          )}
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-rose-200">{title}</h3>
          <p className="mt-1 text-sm text-rose-300/80">{message}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg bg-rose-600/30 text-rose-200 hover:bg-rose-600/50 border border-rose-500/40 transition-colors"
            >
              <svg
                className="w-3.5 h-3.5 mr-1.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Try Again
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
