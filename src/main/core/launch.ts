import { readPaneState, type PaneState } from './layout-state.ts';
import { launchRefusals } from './refused-files.ts';
import { readSettingsSync, type Settings } from './settings.ts';

/**
 * Every file PicPatch opens to start, read before anything is written. The refused ones stop the launch together,
 * named in one error; any other failure stops it as it is.
 */
export function readLaunchFiles(paths: { config: string; state: string }): { settings: Settings; pane: PaneState } {
  const errors: unknown[] = [];
  let settings: Settings | undefined, pane: PaneState | undefined;
  try { settings = readSettingsSync(paths.config); } catch (error) { errors.push(error); }
  try { pane = readPaneState(paths.state); } catch (error) { errors.push(error); }
  if (errors.length) throw launchRefusals(errors) ?? errors[0];
  return { settings: settings!, pane: pane! };
}
