import type { AppState } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  getCodexSelectionLaneKey,
  type CodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import { isWslShellName } from '../../../shared/local-windows-terminal-runtime'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { GlobalSettings, TerminalTab } from '../../../shared/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'

type RuntimeEnvironmentSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>

/**
 * Lane keys for panes whose Codex credentials come from another machine.
 *
 * Why they need keys at all: a managed Codex account is scoped to one machine
 * AND one runtime (`host` or `wsl:<distro>`). A relay environment keeps its own
 * account roster, and an SSH connection has no Orca-managed selection whatsoever
 * — the remote Codex reads that machine's own credentials. Neither can be
 * stranded by a local selection change, so they must not share the local keys.
 */
const RUNTIME_ENVIRONMENT_LANE_PREFIX = 'env:'
const SSH_CONNECTION_LANE_KEY = 'ssh-connection'
const UNATTRIBUTED_REMOTE_LANE_KEY = 'remote-runtime'

/** True for the lanes an on-disk pane-account record can name. */
export function isLocalCodexSelectionLaneKey(laneKey: string): boolean {
  return laneKey === 'host' || laneKey.startsWith('wsl:')
}

/**
 * True when the pane's shell runs on a machine other than this one.
 *
 * Why it takes only the id: a `remote:`/`ssh:` prefix is assigned at spawn and
 * is decisive on its own, so callers with no store access (the bind-driven
 * sweep) can skip these panes before spending a 15s RPC on them.
 */
export function isForeignMachineCodexPtyId(ptyId: string): boolean {
  return parseRemoteRuntimePtyId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}

/** The lane a Codex account mutation rewrites, so only its panes go stale. */
export function getCodexAccountSwitchLaneKey(args: {
  settings: RuntimeEnvironmentSettings | null | undefined
  target?: CodexAccountSelectionTarget | null
}): string {
  const runtimeTarget = getActiveRuntimeTarget(args.settings)
  // Why: with an environment active the mutation is RPC'd to that machine's
  // roster and local GlobalSettings are never touched, so the local host/WSL
  // panes are exactly the ones the switch cannot have affected.
  if (runtimeTarget.kind === 'environment') {
    return `${RUNTIME_ENVIRONMENT_LANE_PREFIX}${runtimeTarget.environmentId}`
  }
  return getCodexSelectionLaneKey(args.target)
}

/** The lane a live pane resolves its Codex account from. */
export function resolveCodexPaneSelectionLaneKey(args: {
  state: Pick<AppState, 'folderWorkspaces' | 'settings' | 'worktreesByRepo'>
  tab: Pick<TerminalTab, 'shellOverride' | 'worktreeId'>
  ptyId: string
}): string {
  const remoteParts = parseRemoteRuntimePtyId(args.ptyId)
  if (remoteParts !== null) {
    const runtimeTarget = getActiveRuntimeTarget(args.state.settings)
    // Why: mirror inspectRuntimeTerminalProcess — an owner-less remote id is
    // routed to whichever environment is active, so that is its lane too.
    const environmentId =
      remoteParts.environmentId?.trim() ||
      (runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null)
    return environmentId
      ? `${RUNTIME_ENVIRONMENT_LANE_PREFIX}${environmentId}`
      : UNATTRIBUTED_REMOTE_LANE_KEY
  }
  if (parseAppSshPtyId(args.ptyId) !== null) {
    return SSH_CONNECTION_LANE_KEY
  }
  return getCodexSelectionLaneKey(resolveLocalPaneSelectionTarget(args))
}

/**
 * Mirrors the main-process getCodexSelectionTargetForPty, from renderer state.
 *
 * Why the workspace path stands in for the PTY cwd: an explorer-created terminal
 * can start below the workspace root, but never outside it, so the WSL distro is
 * the same either way. Misreading a host pane as WSL would silently drop its
 * restart notice, so only the two signals a launch itself uses count as WSL.
 */
function resolveLocalPaneSelectionTarget(args: {
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>
  tab: Pick<TerminalTab, 'shellOverride' | 'worktreeId'>
}): CodexAccountSelectionTarget {
  const workspacePath = getWorkspacePath(args.state, args.tab.worktreeId)
  const wslPath = workspacePath ? parseWslUncPath(workspacePath) : null
  if (wslPath || isWslShellName(args.tab.shellOverride)) {
    return { runtime: 'wsl', wslDistro: wslPath?.distro ?? null }
  }
  return { runtime: 'host' }
}

function getWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type === 'folder') {
    return (
      state.folderWorkspaces.find((workspace) => workspace.id === parsed.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  return (
    Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)?.path ?? null
  )
}
