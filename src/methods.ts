// Host API method names, in one place. All of them are worker-only methods.
export const M = {
  workspaceCreate: 'workspace.create',
  terminalRead: 'terminal.read',
  terminalClose: 'terminal.close',
  terminalList: 'terminal.list',
  agentsList: 'agents.list',
  projectList: 'project.list',
  statusBarUpdate: 'statusBar.update',
  secretsProtection: 'secrets.protection'
} as const
