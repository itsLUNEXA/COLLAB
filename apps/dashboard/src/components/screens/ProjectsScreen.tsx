import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Project, ProjectMember, ProvisionedDevice } from '../../types/api';
import { LoadingState } from '../common/LoadingState';
import { ErrorState } from '../common/ErrorState';
import { EmptyState } from '../common/EmptyState';

export const ProjectsScreen: React.FC = () => {
  const { projectId, setProjectId, setToken, apiClient, generateDevToken, userId } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [projectsList, setProjectsList] = useState<Project[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  // Modal & Onboarding States
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New Project Form
  const [formName, setFormName] = useState('');
  const [formRepoOwner, setFormRepoOwner] = useState('itsLUNEXA');
  const [formRepoName, setFormRepoName] = useState('');
  const [formDefaultBranch, setFormDefaultBranch] = useState('main');
  const [formWorkspacePath, setFormWorkspacePath] = useState('');
  const [formShivamEmail, setFormShivamEmail] = useState('shivam@antigravity.local');
  const [formShivamName, setFormShivamName] = useState('Shivam');

  // Provisioning Result Dialog
  const [provisionResult, setProvisionResult] = useState<{
    project: Project;
    myDevice: ProvisionedDevice;
    shivamDevice?: ProvisionedDevice;
  } | null>(null);

  // Invite Member Form
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');

  const fetchProjectData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setIsOffline(false);

      const [projRes, listRes, membersRes] = await Promise.allSettled([
        apiClient.getProject(projectId),
        apiClient.listProjects(),
        apiClient.getProjectMembers(projectId),
      ]);

      if (projRes.status === 'fulfilled') {
        setProject(projRes.value.project);
      } else {
        throw projRes.reason;
      }

      if (listRes.status === 'fulfilled') {
        setProjectsList(listRes.value.projects);
      }

      if (membersRes.status === 'fulfilled') {
        setMembers(membersRes.value.members);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch project details');
      setIsOffline(Boolean(err?.isOffline));
    } finally {
      setLoading(false);
    }
  }, [projectId, apiClient]);

  const handleRetry = useCallback(async () => {
    if (error?.toLowerCase().includes('token') || error?.includes('401')) {
      try {
        await generateDevToken();
      } catch {}
    }
    fetchProjectData();
  }, [error, generateDevToken, fetchProjectData]);

  useEffect(() => {
    fetchProjectData();
  }, [fetchProjectData]);

  // Handle Create New Project
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) return;

    try {
      setIsSubmitting(true);
      setError(null);

      // 1. Create project
      const newProjRes = await apiClient.createProject({
        name: formName.trim(),
        githubRepoOwner: formRepoOwner.trim() || undefined,
        githubRepoName: formRepoName.trim() || undefined,
        defaultBranch: formDefaultBranch.trim() || 'main',
      });
      const newProject = newProjRes.project;
      if (newProjRes.token) {
        apiClient.setToken(newProjRes.token);
      }
      setProjectId(newProject.id, newProjRes.token);

      // 2. Register local developer device (Laptop 1)
      const myDeviceRes = await apiClient.registerDevice(newProject.id, {
        userId,
        deviceName: 'Primary Workstation',
        osInfo: 'Windows (Antigravity IDE)',
        workspacePath: formWorkspacePath.trim() || undefined,
      });

      // 3. If collaborator info provided, add collaborator & register device for Shivam
      let shivamDeviceRes: ProvisionedDevice | undefined;
      if (formShivamEmail.trim()) {
        const memberRes = await apiClient.addProjectMember(newProject.id, {
          name: formShivamName.trim() || 'Shivam',
          email: formShivamEmail.trim(),
          role: 'MEMBER',
        });

        shivamDeviceRes = await apiClient.registerDevice(newProject.id, {
          userId: memberRes.member.user_id,
          deviceName: `${formShivamName.trim()}'s Laptop`,
          osInfo: 'Remote Workstation',
        });
      }

      // 4. Update active project & show setup instruction modal
      setProvisionResult({
        project: newProject,
        myDevice: myDeviceRes,
        shivamDevice: shivamDeviceRes,
      });

      setIsCreateModalOpen(false);
      fetchProjectData();
    } catch (err: any) {
      alert(`Could not create project: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Invite Collaborator
  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName.trim() || !inviteEmail.trim()) return;

    try {
      setIsSubmitting(true);
      await apiClient.addProjectMember(projectId, {
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setIsInviteModalOpen(false);
      setInviteName('');
      setInviteEmail('');
      fetchProjectData();
    } catch (err: any) {
      alert(`Failed to add team member: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading && !project) {
    return <LoadingState message="Loading project information & team metadata..." />;
  }

  if (error && !project) {
    return (
      <ErrorState
        title="Project Load Error"
        message={error}
        isOffline={isOffline}
        onRetry={handleRetry}
      />
    );
  }

  if (!project) {
    return (
      <EmptyState
        title="Project Not Found"
        description={`No project configuration was found for ID: ${projectId}`}
        actionText="Try Again"
        onAction={fetchProjectData}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header & Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Project & Team Collaboration</h2>
          <p className="text-sm text-slate-400">
            Multi-developer project setup, Git branch routing, and live peer presence.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          {/* Project Switcher Dropdown */}
          {projectsList.length > 1 && (
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-200 font-medium focus:outline-none focus:border-indigo-500"
            >
              {projectsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={() => setIsInviteModalOpen(true)}
            className="px-3.5 py-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center space-x-1.5 transition-colors"
          >
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
            </svg>
            <span>Add Collaborator</span>
          </button>

          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white text-xs font-semibold shadow-lg shadow-indigo-600/20 flex items-center space-x-1.5 transition-all"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Add New Project</span>
          </button>
        </div>
      </div>

      {/* Main Project Card */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl backdrop-blur-sm space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between pb-6 border-b border-slate-800 gap-4">
          <div>
            <div className="flex items-center space-x-3">
              <h3 className="text-lg font-bold text-white">{project.name}</h3>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                Seq #{project.current_seq_num}
              </span>
            </div>
            <p className="text-xs text-slate-500 font-mono mt-1">Project ID: {project.id}</p>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-xs text-slate-400">Team:</span>
            <span className="px-2.5 py-1 rounded-lg bg-slate-800 text-xs font-mono text-slate-300">
              {project.team_id}
            </span>
          </div>
        </div>

        {/* Branch Routing Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl border border-slate-800/80 bg-slate-950/40">
            <div className="text-xs text-slate-400 font-medium mb-1">Default Branch</div>
            <div className="text-sm font-semibold text-slate-200 font-mono flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-slate-400"></span>
              <span>{project.default_branch}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Mainline stable release branch</p>
          </div>

          <div className="p-4 rounded-xl border border-indigo-500/20 bg-indigo-950/10">
            <div className="text-xs text-indigo-300 font-medium mb-1">WIP Checkpoint Branch</div>
            <div className="text-sm font-semibold text-indigo-200 font-mono flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
              <span>{project.wip_branch}</span>
            </div>
            <p className="text-[11px] text-indigo-400/80 mt-1">Continuous peer snapshot branch</p>
          </div>

          <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-950/10">
            <div className="text-xs text-emerald-300 font-medium mb-1">Verified Integration Branch</div>
            <div className="text-sm font-semibold text-emerald-200 font-mono flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>{project.integrated_branch}</span>
            </div>
            <p className="text-[11px] text-emerald-400/80 mt-1">Gatekeeper verified release branch</p>
          </div>
        </div>

        {/* GitHub Integration Details */}
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 space-y-3">
          <div className="flex items-center space-x-2">
            <svg className="w-5 h-5 text-slate-300" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <h4 className="text-sm font-semibold text-slate-200">GitHub Repository Integration</h4>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-slate-500 block">Repository Owner</span>
              <span className="font-mono text-slate-300 font-medium">
                {project.github_repo_owner || 'Not Configured'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Repository Name</span>
              <span className="font-mono text-slate-300 font-medium">
                {project.github_repo_name || 'Not Configured'}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">GitHub App Status</span>
              <span className="font-mono text-emerald-400 font-medium flex items-center space-x-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                <span>Active (Installation #173318191)</span>
              </span>
            </div>
          </div>
        </div>

        {/* Live Team Collaborators */}
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-200">Team Collaborators ({members.length})</h4>
            <span className="text-xs text-slate-500 font-medium">
              Live status reflected from active WebSocket connections
            </span>
          </div>

          {members.length === 0 ? (
            <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 text-xs text-slate-400">
              No collaborators registered yet. Click &quot;Add Collaborator&quot; above to invite Shivam.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {members.map((m) => (
                <div
                  key={m.user_id}
                  className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/60 flex items-center justify-between"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-9 h-9 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 flex items-center justify-center font-bold text-xs uppercase">
                      {m.name.slice(0, 2)}
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-white">{m.name}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{m.email}</div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono text-slate-400 bg-slate-800">
                      {m.role}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold flex items-center space-x-1 ${
                        m.is_online
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-slate-800 text-slate-500 border border-slate-700/50'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          m.is_online ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                        }`}
                      ></span>
                      <span>{m.is_online ? 'ONLINE' : 'DISCONNECTED'}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Sync Model Architecture Explanation Card */}
        <div className="p-4 rounded-xl border border-indigo-500/20 bg-indigo-950/20 text-xs space-y-2">
          <div className="flex items-center space-x-2 text-indigo-300 font-semibold">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>How Two-Person Collaboration Works (Git vs. COLLAB Live Sync)</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-slate-300 pt-1">
            <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
              <div className="font-semibold text-white mb-1">1. Git & GitHub Repository (Code Sync)</div>
              <p className="text-slate-400 leading-relaxed text-[11px]">
                Both developers clone the shared GitHub repository. You and Shivam work on separate feature branches (e.g., <code className="text-indigo-300">feat/my-module</code> and <code className="text-indigo-300">feat/shivam-module</code>) and open Pull Requests. Git preserves version history, commits, and code review.
              </p>
            </div>
            <div className="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
              <div className="font-semibold text-white mb-1">2. COLLAB Hub (Live Delta Sync & Conflict Guard)</div>
              <p className="text-slate-400 leading-relaxed text-[11px]">
                The desktop companion watches each developer&apos;s local folder. It broadcasts unsaved in-progress file operations, establishes active editing leases to prevent accidental overwrites, detects concurrent edits, and syncs AI context across both IDEs.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* --- MODAL: Add New Project Wizard --- */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-xl w-full shadow-2xl space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-white">Add New Collaboration Project</h3>
                <p className="text-xs text-slate-400">Register a separate application repository and configure two-developer workspaces.</p>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-white text-lg font-bold p-1"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Project Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. My NextGen Application"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">GitHub Repo Owner *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. itsLUNEXA"
                    value={formRepoOwner}
                    onChange={(e) => setFormRepoOwner(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1">GitHub Repo Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. software-project"
                    value={formRepoName}
                    onChange={(e) => setFormRepoName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Default Branch</label>
                <input
                  type="text"
                  value={formDefaultBranch}
                  onChange={(e) => setFormDefaultBranch(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {/* Local Folder Explanation */}
              <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 space-y-2">
                <label className="block text-slate-300 font-medium">Your Local Clone Path (Windows Laptop)</label>
                <input
                  type="text"
                  placeholder="e.g. E:\PROJECTS\my-app"
                  value={formWorkspacePath}
                  onChange={(e) => setFormWorkspacePath(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 font-mono text-[11px] focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[11px] text-slate-400">
                  <strong>Browser Sandbox Notice:</strong> A web dashboard cannot directly read host filesystems. The COLLAB Companion CLI runs on your laptop and binds to this directory.
                </p>
              </div>

              {/* Add Shivam as collaborator */}
              <div className="p-3 rounded-xl bg-indigo-950/20 border border-indigo-500/20 space-y-3">
                <div className="font-semibold text-indigo-300">Invite Collaborator (Shivam)</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 text-[11px] mb-1">Collaborator Name</label>
                    <input
                      type="text"
                      value={formShivamName}
                      onChange={(e) => setFormShivamName(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 text-[11px] mb-1">Collaborator Email</label>
                    <input
                      type="email"
                      value={formShivamEmail}
                      onChange={(e) => setFormShivamEmail(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold flex items-center space-x-2"
                >
                  {isSubmitting ? <span>Creating...</span> : <span>Create & Provision Devices</span>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: Add Collaborator --- */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white">Add Team Collaborator</h3>
              <button
                onClick={() => setIsInviteModalOpen(false)}
                className="text-slate-400 hover:text-white text-lg font-bold p-1"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleInviteMember} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Shivam"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Email</label>
                <input
                  type="email"
                  required
                  placeholder="e.g. shivam@antigravity.local"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">Project Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="MEMBER">Collaborator (Member)</option>
                  <option value="ADMIN">Team Admin</option>
                </select>
              </div>

              <div className="flex items-center justify-end space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsInviteModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold"
                >
                  {isSubmitting ? 'Adding...' : 'Add Member'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- DIALOG: Provisioning Result & Companion Setup Instructions --- */}
      {provisionResult && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-6 max-w-2xl w-full shadow-2xl space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                <h3 className="text-base font-bold text-white">Project Onboarded Successfully!</h3>
              </div>
              <button
                onClick={() => setProvisionResult(null)}
                className="text-slate-400 hover:text-white text-lg font-bold p-1"
              >
                &times;
              </button>
            </div>

            <div className="text-xs text-slate-300 space-y-4">
              <p>
                Project <strong className="text-white">{provisionResult.project.name}</strong> is registered under ID:
                <code className="ml-1 px-2 py-0.5 rounded bg-slate-950 text-indigo-300 font-mono">
                  {provisionResult.project.id}
                </code>
              </p>

              {/* Instructions for Laptop 1 */}
              <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                <div className="font-bold text-white flex items-center justify-between">
                  <span>1. On Your Windows Laptop (Primary)</span>
                  <span className="text-[11px] text-slate-400 font-mono">Device: {provisionResult.myDevice.device.id.slice(0, 8)}...</span>
                </div>
                <p className="text-slate-400 text-[11px]">Run in PowerShell to watch your local clone:</p>
                <pre className="p-3 rounded-lg bg-slate-900 text-indigo-300 font-mono text-[11px] overflow-x-auto select-all">
{`node apps/companion/dist/cli.js --project-id ${provisionResult.project.id} --device-id ${provisionResult.myDevice.device.id} --secret ${provisionResult.myDevice.deviceSecret} --workspace "${formWorkspacePath || 'C:\\path\\to\\clone'}"`}
                </pre>
              </div>

              {/* Instructions for Laptop 2 (Shivam) */}
              {provisionResult.shivamDevice && (
                <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                  <div className="font-bold text-white flex items-center justify-between">
                    <span>2. On Shivam&apos;s Laptop</span>
                    <span className="text-[11px] text-slate-400 font-mono">Device: {provisionResult.shivamDevice.device.id.slice(0, 8)}...</span>
                  </div>
                  <p className="text-slate-400 text-[11px]">
                    Shivam clones the repository and runs the companion daemon:
                  </p>
                  <pre className="p-3 rounded-lg bg-slate-900 text-indigo-300 font-mono text-[11px] overflow-x-auto select-all">
{`git clone https://github.com/${provisionResult.project.github_repo_owner}/${provisionResult.project.github_repo_name}.git
node apps/companion/dist/cli.js --server ws://<your-host-ip>:4000/ws --project-id ${provisionResult.project.id} --device-id ${provisionResult.shivamDevice.device.id} --secret ${provisionResult.shivamDevice.deviceSecret} --workspace "./${provisionResult.project.github_repo_name}"`}
                  </pre>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-800">
              <button
                onClick={() => setProvisionResult(null)}
                className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
