import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { translate } from '@/i18n/i18n'
import { isCodexRestartEligiblePane } from './codex-pane-restart-eligibility'
import {
  getCodexAccountSwitchLaneKey,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLaneKey
} from './codex-pane-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'

// Why: prompt integrations such as Starship can outlast the daemon's 300ms
// Codex fast-path timeout; account restarts must wait until the shell accepts input.
export const CODEX_ACCOUNT_RESTART_STARTUP = {
  command: 'codex',
  startupCommandDelivery: 'shell-ready'
} as const

export type CodexPaneScanResult = {
  ptyId: string
  /** The pane may be shown a restart prompt (see isCodexRestartEligiblePane). */
  eligible: boolean
  /** Inspection failed or the handle was stale, so a later read may answer differently. */
  inconclusive: boolean
  /** Orca launched Codex in this tab, so a shell foreground can still be reattach settle. */
  launchedCodex: boolean
  /** A restart notice was raised for this pane by this scan. */
  notified: boolean
}

/**
 * Reports which panes are running Codex, skipping any outside the caller's lane.
 *
 * Why the lane filter runs BEFORE inspection rather than after: an out-of-lane
 * answer cannot change the outcome, and the inspection is not free — a pane on a
 * relay environment costs a 15s-timeout RPC per look. Skipping first is also
 * what keeps a restart notice (which drops every keystroke in the pane) off a
 * remote Codex session that no local account change can possibly strand.
 */
async function scanCodexPanes(
  state: AppState,
  args: {
    ptyIdFilter: ReadonlySet<string> | null
    isLaneInScope: (laneKey: string) => boolean
  }
): Promise<CodexPaneScanResult[]> {
  const tabs = Object.values(state.tabsByWorktree).flat()
  const scans = await Promise.all(
    tabs.map(async (tab) => {
      const ptyIds = (state.ptyIdsByTabId[tab.id] ?? []).filter(
        (ptyId) => args.ptyIdFilter === null || args.ptyIdFilter.has(ptyId)
      )
      // Why: Codex sessions are not reliably discoverable from tab labels.
      // Tabs keep fallback names until a CLI emits an OSC title, and Codex
      // does not always do that. The live process tree plus the tab's recorded
      // launchAgent are the stable evidence that this pane is running Codex.
      return Promise.all(
        ptyIds.map(async (ptyId) => {
          if (!args.isLaneInScope(resolveCodexPaneSelectionLaneKey({ state, tab, ptyId }))) {
            // Why not inconclusive: a pane's lane is fixed at spawn, so this is a
            // final answer and the sweep must not spend a retry rung re-asking.
            return {
              ptyId,
              eligible: false,
              inconclusive: false,
              launchedCodex: false,
              notified: false
            }
          }
          const inspection = await inspectRuntimeTerminalProcess(state.settings, ptyId).then(
            (result) => result,
            // Why: one stale remote pane must not hide restart notices for other confirmed Codex panes.
            () => null
          )
          return {
            ptyId,
            eligible:
              inspection !== null &&
              isCodexRestartEligiblePane({ inspection, launchAgent: tab.launchAgent }),
            inconclusive: inspection === null || inspection.unavailable === true,
            launchedCodex: tab.launchAgent === 'codex',
            notified: false
          }
        })
      )
    })
  )

  return scans.flat()
}

/**
 * Prompts the panes a just-applied account change stranded.
 *
 * `target` names the selection slot the change wrote. Panes outside that lane —
 * a WSL pane on a host switch, or anything running on a relay/SSH machine —
 * never had this account injected, so a notice there is pure damage: it mutes a
 * terminal that is working correctly.
 */
export async function markLiveCodexSessionsForRestart(args: {
  previousAccountLabel: string
  nextAccountLabel: string
  target?: CodexAccountSelectionTarget | null
}): Promise<void> {
  const state = useAppStore.getState()
  const switchLaneKey = getCodexAccountSwitchLaneKey({
    settings: state.settings,
    target: args.target
  })
  const scans = await scanCodexPanes(state, {
    ptyIdFilter: null,
    isLaneInScope: (laneKey) => laneKey === switchLaneKey
  })
  const liveCodexSessionPtyIds = scans.filter((scan) => scan.eligible).map((scan) => scan.ptyId)
  if (liveCodexSessionPtyIds.length === 0) {
    return
  }

  useAppStore.getState().markCodexRestartNotices(
    liveCodexSessionPtyIds.map((ptyId) => ({
      ptyId,
      previousAccountLabel: args.previousAccountLabel,
      nextAccountLabel: args.nextAccountLabel
    }))
  )
}

/**
 * Re-raises restart prompts for panes that outlived the app.
 *
 * Why: restart notices are renderer state, but the shells they describe live in
 * the PTY daemon and survive a full app restart with the old account still
 * baked into their environment. Without this, quitting Orca before restarting a
 * stale pane silently strands it on the previous account forever.
 *
 * Returns one result per inspected pane so the bind-driven sweep can tell an
 * answered pane from one whose PTY has not reported a usable process yet.
 *
 * Scoped to the local host/WSL lanes because the pane-account registry only
 * records daemon host spawns: a relay or SSH pane can never be listed stale, so
 * inspecting one is a guaranteed-fruitless RPC. listStalePanes then does the
 * host-vs-WSL check itself, against each pane's own recorded lane.
 */
export async function markRestoredStaleCodexSessionsForRestart(args?: {
  ptyIds?: readonly string[]
}): Promise<CodexPaneScanResult[]> {
  const state = useAppStore.getState()
  const scans = await scanCodexPanes(state, {
    ptyIdFilter: args?.ptyIds ? new Set(args.ptyIds) : null,
    isLaneInScope: isLocalCodexSelectionLaneKey
  })
  const liveCodexSessionPtyIds = scans.filter((scan) => scan.eligible).map((scan) => scan.ptyId)
  if (liveCodexSessionPtyIds.length === 0) {
    return scans
  }
  const stalePanes = await window.api.codexAccounts.listStalePanes({
    ptyIds: liveCodexSessionPtyIds
  })
  if (stalePanes.length === 0) {
    return scans
  }

  const resolveAccountLabel = await createCodexAccountLabelResolver()
  useAppStore.getState().markCodexRestartNotices(
    stalePanes.map((pane) => ({
      ptyId: pane.ptyId,
      previousAccountLabel: resolveAccountLabel(pane.launchAccountId),
      nextAccountLabel: resolveAccountLabel(pane.activeAccountId)
    }))
  )
  const notifiedPtyIds = new Set(stalePanes.map((pane) => pane.ptyId))
  return scans.map((scan) => (notifiedPtyIds.has(scan.ptyId) ? { ...scan, notified: true } : scan))
}

async function createCodexAccountLabelResolver(): Promise<(accountId: string | null) => string> {
  // Why: a failed roster read still yields usable prompts — the account ids are
  // already known, only their friendly emails are missing.
  const accounts = await window.api.codexAccounts.list().catch(() => null)
  return (accountId) => {
    if (accountId == null) {
      return translate('auto.lib.codex.session.restart.4bd4a3a9c7', 'System default')
    }
    return (
      accounts?.accounts.find((account) => account.id === accountId)?.email ??
      translate('auto.lib.codex.session.restart.9f0b1c2d3e', 'Codex account')
    )
  }
}
