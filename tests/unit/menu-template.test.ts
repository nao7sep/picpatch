import { expect, it } from 'vitest';
import { menuTemplate } from '../../src/desktop/menu-template.ts';
import type { MenuItemConstructorOptions } from 'electron';
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] { return items.flatMap(item => [item, ...flatten(Array.isArray(item.submenu) ? item.submenu : [])]); }
it('keeps native Mac roles, disables modal-incompatible actions and excludes developer tools from packages', () => {
  const mac = flatten(menuTemplate(true,true,true,()=>{},()=>{}));
  expect(mac.find(item => item.id === 'picpatch-about')?.enabled).toBe(false);
  expect(mac.find(item => item.id === 'picpatch-settings')?.enabled).toBe(false);
  expect(mac.some(item => item.role === 'copy')).toBe(true);
  expect(mac.some(item => item.role === 'services')).toBe(true);
  expect(mac.some(item => item.role === 'toggleDevTools')).toBe(false);
  const windows = flatten(menuTemplate(false,false,false,()=>{},()=>{}));
  expect(windows.some(item => item.role === 'services' || item.role === 'front')).toBe(false);
  expect(windows.some(item => item.role === 'toggleDevTools')).toBe(true);
});
