export interface SettingsWrite {
  key: string
  section?: string
  file: string
  line: number
}
export interface SettingsPlacementReport {
  sections: number
  ownedKeys: number
  checkedWrites: number
  files: number
  writes: SettingsWrite[]
  failures: string[]
  passed: boolean
}
export function inspectSettingsPlacement(workspace: string): SettingsPlacementReport
