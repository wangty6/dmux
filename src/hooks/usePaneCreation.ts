import path from 'path';
import * as os from 'os';
import type { DmuxPane } from '../types.js';
import { createPane } from '../utils/paneCreation.js';
import { LogService } from '../services/LogService.js';
import { getAgentSlugSuffix, type AgentName } from '../utils/agentLaunch.js';
import { generateSlug } from '../utils/slug.js';

interface Params {
  panes: DmuxPane[];
  savePanes: (p: DmuxPane[]) => Promise<void>;
  projectName: string;
  sessionProjectRoot: string;
  panesFile: string;
  setIsCreatingPane: (v: boolean) => void;
  setStatusMessage: (msg: string) => void;
  loadPanes: () => Promise<void>;
  availableAgents: AgentName[];
}

interface CreateNewPaneOptions {
  existingPanes?: DmuxPane[];
  slugSuffix?: string;
  slugBase?: string;
  targetProjectRoot?: string;
  skipAgentSelection?: boolean;
}

export default function usePaneCreation({
  panes,
  savePanes,
  projectName,
  sessionProjectRoot,
  panesFile,
  setIsCreatingPane,
  setStatusMessage,
  loadPanes,
  availableAgents,
}: Params) {
  const openInEditor = async (currentPrompt: string, setPrompt: (v: string) => void) => {
    try {
      const fs = await import('fs');
      const { spawnSync } = await import('child_process');
      const tmpFile = path.join(os.tmpdir(), `dmux-prompt-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, currentPrompt || '# Enter your Claude prompt here\n\n');
      const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
      process.stdout.write('\x1b[2J\x1b[H');
      spawnSync(editor, [tmpFile], { stdio: 'inherit', shell: true });
      process.stdout.write('\x1b[2J\x1b[H');
      const content = fs.readFileSync(tmpFile, 'utf8').replace(/^# Enter your Claude prompt here\s*\n*/m, '').trim();
      setPrompt(content);
      fs.unlinkSync(tmpFile);
    } catch {}
  };

  const createPaneInternal = async (
    prompt: string,
    agent?: AgentName,
    options: CreateNewPaneOptions = {}
  ): Promise<DmuxPane> => {
    const panesForCreation = options.existingPanes ?? panes;
    const result = await createPane(
      {
        prompt,
        agent,
        projectName,
        existingPanes: panesForCreation,
        slugSuffix: options.slugSuffix,
        slugBase: options.slugBase,
        projectRoot: options.targetProjectRoot,
        skipAgentSelection: options.skipAgentSelection,
        sessionProjectRoot,
        sessionConfigPath: panesFile,
      },
      availableAgents
    );

    if (result.needsAgentChoice) {
      throw new Error('Agent choice is required');
    }

    return result.pane;
  };

  const createNewPane = async (
    prompt: string,
    agent?: AgentName,
    options: CreateNewPaneOptions = {}
  ): Promise<DmuxPane | null> => {
    const panesForCreation = options.existingPanes ?? panes;

    try {
      setIsCreatingPane(true)
      setStatusMessage("Creating pane...")

      const pane = await createPaneInternal(prompt, agent, options);

      // Save the pane
      const updatedPanes = [...panesForCreation, pane];
      await savePanes(updatedPanes);

      await loadPanes();
      setStatusMessage("Pane created")
      setTimeout(() => setStatusMessage(""), 2000)
      return pane;
    } catch (error) {
      const msg = 'Failed to create pane';
      LogService.getInstance().error(msg, 'usePaneCreation', undefined, error instanceof Error ? error : undefined);
      setStatusMessage(`Failed to create pane: ${error}`);
      setTimeout(() => setStatusMessage(''), 3000);
      return null;
    } finally {
      setIsCreatingPane(false)
    }
  };

  const createPanesForAgents = async (
    prompt: string,
    selectedAgents: AgentName[],
    options: Pick<CreateNewPaneOptions, 'existingPanes' | 'targetProjectRoot'> = {}
  ): Promise<DmuxPane[]> => {
    const panesForCreation = options.existingPanes ?? panes;
    const dedupedAgents = selectedAgents.filter(
      (agent, index) => selectedAgents.indexOf(agent) === index
    );

    if (dedupedAgents.length === 0) {
      return [];
    }

    const isMultiLaunch = dedupedAgents.length > 1;
    const slugBase = isMultiLaunch ? await generateSlug(prompt) : undefined;

    try {
      setIsCreatingPane(true);
      setStatusMessage(`Creating ${dedupedAgents.length} pane${dedupedAgents.length === 1 ? '' : 's'}...`);

      const createdPanesList: DmuxPane[] = [];
      const failures: Array<{ agent: AgentName; error: unknown }> = [];

      // Create panes sequentially to avoid window allocation race conditions.
      // Parallel creation caused stale existingPanes snapshots, leading to
      // multiple panes being allocated to the same window beyond the limit.
      for (const selectedAgent of dedupedAgents) {
        try {
          const pane = await createPaneInternal(prompt, selectedAgent, {
            existingPanes: [...panesForCreation, ...createdPanesList],
            slugSuffix: isMultiLaunch ? getAgentSlugSuffix(selectedAgent) : undefined,
            slugBase,
            targetProjectRoot: options.targetProjectRoot,
          });
          createdPanesList.push(pane);
        } catch (error) {
          failures.push({ agent: selectedAgent, error });
          LogService.getInstance().error(
            `Failed to create pane for agent ${selectedAgent}`,
            'usePaneCreation',
            undefined,
            error instanceof Error ? error : undefined
          );
        }
      }

      if (createdPanesList.length > 0) {
        const updatedPanes = [...panesForCreation, ...createdPanesList];
        await savePanes(updatedPanes);
        await loadPanes();
      }

      if (failures.length > 0) {
        setStatusMessage(
          `Created ${createdPanesList.length}/${dedupedAgents.length} panes (${failures.length} failed)`
        );
      } else {
        setStatusMessage(
          `Created ${createdPanesList.length} pane${createdPanesList.length === 1 ? '' : 's'}`
        );
      }
      setTimeout(() => setStatusMessage(""), 3000);

      return createdPanesList;
    } catch (error) {
      LogService.getInstance().error(
        'Failed to create panes',
        'usePaneCreation',
        undefined,
        error instanceof Error ? error : undefined
      );
      setStatusMessage(`Failed to create panes: ${error}`);
      setTimeout(() => setStatusMessage(''), 3000);
      return [];
    } finally {
      setIsCreatingPane(false);
    }
  };

  return { openInEditor, createNewPane, createPanesForAgents } as const;
}
