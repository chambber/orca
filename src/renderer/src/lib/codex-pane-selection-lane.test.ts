import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store'
import { getCodexSelectionLaneKey } from '../../../shared/codex-selection-lane'
import {
  getCodexAccountSwitchLaneKey,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLaneKey
} from './codex-pane-selection-lane'

type LaneState = Pick<AppState, 'folderWorkspaces' | 'settings' | 'worktreesByRepo'>

function laneState(args?: {
  activeRuntimeEnvironmentId?: string | null
  worktreePath?: string
  folderPath?: string
}): LaneState {
  return {
    folderWorkspaces: args?.folderPath ? [{ id: 'fw1', folderPath: args.folderPath }] : [],
    settings: {
      activeRuntimeEnvironmentId: args?.activeRuntimeEnvironmentId ?? null
    },
    worktreesByRepo: {
      repo1: [{ id: 'wt1', path: args?.worktreePath ?? '/Users/dev/code/orca' }]
    }
  } as unknown as LaneState
}

const HOST_TAB = { worktreeId: 'wt1', shellOverride: undefined }

describe('resolveCodexPaneSelectionLaneKey', () => {
  it('keys an ordinary local pane to the host lane', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({ state: laneState(), tab: HOST_TAB, ptyId: 'pty-1' })
    ).toBe('host')
  })

  it('keys a pane in a WSL UNC worktree to that distro lane', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' }),
        tab: HOST_TAB,
        ptyId: 'pty-1'
      })
    ).toBe('wsl:Ubuntu')
  })

  it('keys a wsl.exe pane outside a UNC worktree to the default WSL lane', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState(),
        tab: { worktreeId: 'wt1', shellOverride: 'wsl.exe' },
        ptyId: 'pty-1'
      })
    ).toBe('wsl:__default__')
  })

  it('reads the distro from a folder workspace path too', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ folderPath: '\\\\wsl$\\Debian\\srv\\app' }),
        tab: { worktreeId: 'folder:fw1', shellOverride: undefined },
        ptyId: 'pty-1'
      })
    ).toBe('wsl:Debian')
  })

  it('keys an owned remote runtime pane to its own environment, not the active one', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ activeRuntimeEnvironmentId: 'env-active' }),
        tab: HOST_TAB,
        ptyId: 'remote:env-owner@@term-1'
      })
    ).toBe('env:env-owner')
  })

  it('routes an owner-less remote pane to the active environment, as inspection does', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ activeRuntimeEnvironmentId: 'env-1' }),
        tab: HOST_TAB,
        ptyId: 'remote:term-1'
      })
    ).toBe('env:env-1')
  })

  it('keys an SSH-connection pane to a lane no account selection can name', () => {
    const laneKey = resolveCodexPaneSelectionLaneKey({
      state: laneState(),
      tab: HOST_TAB,
      ptyId: 'ssh:my-box@@pty-7'
    })
    expect(laneKey).toBe('ssh-connection')
    // Why: managed Codex accounts are only ever 'host' or 'wsl:<distro>', so no
    // switch can produce this key — the pane is unreachable by any selection.
    expect(laneKey).not.toBe(getCodexSelectionLaneKey({ runtime: 'host' }))
    expect(isLocalCodexSelectionLaneKey(laneKey)).toBe(false)
  })
})

describe('getCodexAccountSwitchLaneKey', () => {
  it('scopes a local switch to the runtime slot it wrote', () => {
    expect(getCodexAccountSwitchLaneKey({ settings: null, target: { runtime: 'host' } })).toBe(
      'host'
    )
    expect(
      getCodexAccountSwitchLaneKey({
        settings: null,
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })
    ).toBe('wsl:Ubuntu')
  })

  it('scopes a switch made against a runtime environment to that machine', () => {
    expect(
      getCodexAccountSwitchLaneKey({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        target: { runtime: 'host' }
      })
    ).toBe('env:env-1')
  })

  it('never lets a local host switch claim a remote or SSH pane', () => {
    const hostSwitch = getCodexAccountSwitchLaneKey({ settings: null, target: { runtime: 'host' } })
    const state = laneState()
    for (const ptyId of ['remote:env-owner@@term-1', 'ssh:my-box@@pty-7']) {
      expect(resolveCodexPaneSelectionLaneKey({ state, tab: HOST_TAB, ptyId })).not.toBe(hostSwitch)
    }
  })
})

describe('isForeignMachineCodexPtyId', () => {
  it('separates panes whose shell runs on another machine from local ones', () => {
    expect(isForeignMachineCodexPtyId('remote:env-1@@term-1')).toBe(true)
    expect(isForeignMachineCodexPtyId('remote:term-1')).toBe(true)
    expect(isForeignMachineCodexPtyId('ssh:my-box@@pty-7')).toBe(true)
    expect(isForeignMachineCodexPtyId('pty-1')).toBe(false)
  })

  it('agrees with the lane keys, so the sweep and the scan skip the same panes', () => {
    const state = laneState({ activeRuntimeEnvironmentId: 'env-1' })
    for (const ptyId of ['remote:env-1@@term-1', 'remote:term-1', 'ssh:my-box@@pty-7', 'pty-1']) {
      expect(
        isLocalCodexSelectionLaneKey(
          resolveCodexPaneSelectionLaneKey({ state, tab: HOST_TAB, ptyId })
        )
      ).toBe(!isForeignMachineCodexPtyId(ptyId))
    }
  })
})
