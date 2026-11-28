// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { PairResult, PanelState } from './plugin.ts'

declare module 'orca' {
  interface PluginRequests {
    /** Everything the panel draws: links, their status, key store, CLI. */
    'state.get': { output: PanelState }
    /** Redeems a linking code (POST /connector/pair) and starts the new link. */
    'link.pair': { input: { code: string; host_label?: string }; output: PairResult }
    /** Removes a link from this Orca; tells the skill if the link is online. */
    'link.unlink': { input: { link_id: string }; output: { ok: boolean } }
    /** Sets which projects a link may touch. */
    'link.projects.set': {
      input: { link_id: string; projects: { id: string; host_id: string }[] }
      output: { ok: boolean }
    }
    /** Turns "Allow all projects" on or off for a link (off by default). */
    'link.projects.allowAll': { input: { link_id: string; on: boolean }; output: { ok: boolean } }
    /** Turns "Allow adding projects" on or off for a link (off by default, dev#2424). */
    'link.addProjects.allow': { input: { link_id: string; on: boolean }; output: { ok: boolean } }
    /** Git projects Orca lists, local and SSH. */
    'projects.list': {
      output: { ok: boolean; projects: { id: string; name: string; host_id: string; path: string }[] }
    }
  }
  interface PluginPanelEvents {
    /** Posted whenever a link, a status or a job count changes. */
    'state.changed': PanelState
  }
}
