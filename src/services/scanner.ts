import { ProjectScanResult } from '../types';

export async function selectProject(): Promise<string | null> {
  return window.prototypeStudio.selectProject();
}

export async function scanProject(projectRoot: string): Promise<ProjectScanResult> {
  return window.prototypeStudio.scanProject(projectRoot);
}
