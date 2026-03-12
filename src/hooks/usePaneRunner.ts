import { execSync } from 'child_process';
import fs from 'fs/promises';
import { open, type FileHandle } from 'fs/promises';
import type { DmuxPane, ProjectSettings } from '../types.js';
import { TmuxService } from '../services/TmuxService.js';
import { enforceControlPaneSize } from '../utils/tmux.js';
import { SIDEBAR_WIDTH } from '../utils/layoutManager.js';

const WINDOW_SIZE = 100_000; // 100KB sliding window for regex matching

interface MonitorState {
  handle?: FileHandle;
  position: number;
  window: string;
}

interface Params {
  panes: DmuxPane[];
  savePanes: (p: DmuxPane[]) => Promise<void>;
  projectSettings: ProjectSettings;
  setStatusMessage: (msg: string) => void;
  setRunningCommand: (v: boolean) => void;
}

export default function usePaneRunner({ panes, savePanes, projectSettings, setStatusMessage, setRunningCommand }: Params) {
  const copyNonGitFiles = async (worktreePath: string, sourceProjectRoot?: string) => {
    try {
      setStatusMessage('Copying non-git files from main...');
      const derivedRoot = worktreePath.replace(/[\\\/]\.dmux[\\\/]worktrees[\\\/][^\\\/]+$/, '');
      const projectRoot = sourceProjectRoot
        || (derivedRoot !== worktreePath ? derivedRoot : undefined)
        || execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      const rsyncCmd = `rsync -avz --exclude='.git' --exclude='.dmux' --exclude='node_modules' --exclude='dist' --exclude='build' --exclude='.next' --exclude='.turbo' "${projectRoot}/" "${worktreePath}/"`;
      execSync(rsyncCmd, { stdio: 'pipe' });
      setStatusMessage('Non-git files copied successfully');
      setTimeout(() => setStatusMessage(''), 2000);
    } catch {
      setStatusMessage('Failed to copy non-git files');
      setTimeout(() => setStatusMessage(''), 2000);
    }
  };

  const runCommandInternal = async (type: 'test' | 'dev', pane: DmuxPane) => {
    if (!pane.worktreePath) {
      setStatusMessage('No worktree path for this pane');
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }

    const command = type === 'test' ? projectSettings.testCommand : projectSettings.devCommand;
    if (!command) {
      setStatusMessage('No command configured');
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }

    try {
      setRunningCommand(true);
      setStatusMessage(`Starting ${type} in background window...`);

      const tmuxService = TmuxService.getInstance();

      const existingWindowId = type === 'test' ? pane.testWindowId : pane.devWindowId;
      if (existingWindowId) {
        try { await tmuxService.killWindow(existingWindowId); } catch {}
      }

      const windowName = `${pane.slug}-${type}`;
      const windowId = await tmuxService.newWindow({ name: windowName, detached: true });
      const logFile = `/tmp/dmux-${pane.id}-${type}.log`;
      const fullCommand = `cd "${pane.worktreePath}" && ${command} 2>&1 | tee ${logFile}`;
      await tmuxService.sendKeys(windowId, `'${fullCommand.replace(/'/g, "'\\''")}' Enter`);

      const updatedPane: DmuxPane = {
        ...pane,
        [type === 'test' ? 'testWindowId' : 'devWindowId']: windowId,
        [type === 'test' ? 'testStatus' : 'devStatus']: 'running'
      } as DmuxPane;

      const updatedPanes = panes.map(p => p.id === pane.id ? updatedPane : p);
      await savePanes(updatedPanes);

      const state: MonitorState = { position: 0, window: '' };
      if (type === 'test') setTimeout(() => monitorTestOutput(pane.id, logFile, state), 2000);
      else setTimeout(() => monitorDevOutput(pane.id, logFile, state), 2000);

      setRunningCommand(false);
      setStatusMessage(`${type === 'test' ? 'Test' : 'Dev server'} started in background`);
      setTimeout(() => setStatusMessage(''), 3000);
    } catch {
      setRunningCommand(false);
      setStatusMessage(`Failed to run ${type} command`);
      setTimeout(() => setStatusMessage(''), 3000);
    }
  };

  const monitorTestOutput = async (paneId: string, logFile: string, state: MonitorState) => {
    try {
      if (!state.handle) {
        state.handle = await open(logFile, 'r');
      }
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await state.handle.read(buf, 0, buf.length, state.position);
      if (bytesRead > 0) {
        state.position += bytesRead;
        state.window += buf.toString('utf-8', 0, bytesRead);
        if (state.window.length > WINDOW_SIZE) {
          state.window = state.window.slice(-WINDOW_SIZE);
        }
      }

      let status: 'passed' | 'failed' | 'running' = 'running';
      if (state.window.match(/(?:tests?|specs?) (?:passed|✓|succeeded)/i) || state.window.match(/\b0 fail(?:ing|ed|ures?)\b/i)) {
        status = 'passed';
      } else if (state.window.match(/(?:tests?|specs?) (?:failed|✗|✖)/i) || state.window.match(/\d+ fail(?:ing|ed|ures?)/i) || state.window.match(/error:/i)) {
        status = 'failed';
      }

      const pane = panes.find(p => p.id === paneId);
      if (pane?.testWindowId) {
        try {
          execSync(`tmux list-windows -F '#{window_id}' | rg -q '${pane.testWindowId}'`, { stdio: 'pipe' });
          const paneOutput = execSync(`tmux capture-pane -t '${pane.testWindowId}' -p | tail -5`, { encoding: 'utf-8' });
          if (paneOutput.includes('$') || paneOutput.includes('#')) {
            if (status === 'running') status = 'passed';
          }
        } catch {
          if (status === 'running') status = 'failed';
        }
      }

      const updatedPanes = panes.map(p => p.id === paneId ? { ...p, testStatus: status, testOutput: state.window.slice(-5000) } : p);
      await savePanes(updatedPanes);
      if (status === 'running') {
        setTimeout(() => monitorTestOutput(paneId, logFile, state), 2000);
      } else {
        await state.handle.close();
        state.handle = undefined;
      }
    } catch {
      if (state.handle) {
        try { await state.handle.close(); } catch {}
        state.handle = undefined;
      }
    }
  };

  const monitorDevOutput = async (paneId: string, logFile: string, state: MonitorState) => {
    try {
      if (!state.handle) {
        state.handle = await open(logFile, 'r');
      }
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await state.handle.read(buf, 0, buf.length, state.position);
      if (bytesRead > 0) {
        state.position += bytesRead;
        state.window += buf.toString('utf-8', 0, bytesRead);
        if (state.window.length > WINDOW_SIZE) {
          state.window = state.window.slice(-WINDOW_SIZE);
        }
      }

      const urlMatch = state.window.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i) || state.window.match(/Local:\s+(https?:\/\/[^\s]+)/i) || state.window.match(/listening on port (\d+)/i);
      let devUrl = '';
      if (urlMatch) {
        if (urlMatch[0].startsWith('http')) devUrl = urlMatch[0];
        else if ((urlMatch as any)[1]) devUrl = `http://localhost:${(urlMatch as any)[1]}`;
      }
      const pane = panes.find(p => p.id === paneId);
      let status: 'running' | 'stopped' = 'running';
      if (pane?.devWindowId) {
        try { execSync(`tmux list-windows -F '#{window_id}' | rg -q '${pane.devWindowId}'`, { stdio: 'pipe' }); } catch { status = 'stopped'; }
      }
      const updatedPanes = panes.map(p => p.id === paneId ? { ...p, devStatus: status, devUrl: devUrl || p.devUrl } : p);
      await savePanes(updatedPanes);
      if (status === 'running') {
        setTimeout(() => monitorDevOutput(paneId, logFile, state), 2000);
      } else {
        await state.handle.close();
        state.handle = undefined;
      }
    } catch {
      if (state.handle) {
        try { await state.handle.close(); } catch {}
        state.handle = undefined;
      }
    }
  };

  const attachBackgroundWindow = async (pane: DmuxPane, type: 'test' | 'dev') => {
    const windowId = type === 'test' ? pane.testWindowId : pane.devWindowId;
    if (!windowId) {
      setStatusMessage(`No ${type} window to attach`);
      setTimeout(() => setStatusMessage(''), 2000);
      return;
    }
    try {
      const tmuxService = TmuxService.getInstance();
      await tmuxService.joinPane(windowId, true);
      // Don't apply global layouts - just enforce sidebar width
      try {
        const controlPaneId = await tmuxService.getCurrentPaneId();
        enforceControlPaneSize(controlPaneId, SIDEBAR_WIDTH);
      } catch {}
      await tmuxService.selectPane('{last}');
      setStatusMessage(`Attached ${type} window`);
      setTimeout(() => setStatusMessage(''), 2000);
    } catch {
      setStatusMessage(`Failed to attach ${type} window`);
      setTimeout(() => setStatusMessage(''), 2000);
    }
  };

  return { copyNonGitFiles, runCommandInternal, monitorTestOutput, monitorDevOutput, attachBackgroundWindow } as const;
}
