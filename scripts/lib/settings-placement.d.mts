export interface SettingsPlacementReport {
  sections: number
  ownedKeys: number
  renderedSections: number
  tabs: number
  failures: string[]
  passed: boolean
}
export function inspectSettingsPlacement(workspace: string): SettingsPlacementReport
