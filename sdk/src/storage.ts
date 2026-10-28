import * as fs from 'node:fs/promises';

/**
 * The SDK's file calls, in one module tests can replace. Local file work is awaited to its end with no deadline of its
 * own: a stalled volume holds the call until the operating system returns (`sdk-conventions`).
 */
export const { chmod, mkdir, mkdtemp, rename, link, rm, unlink, writeFile, copyFile, symlink, access, lstat, stat, realpath, readdir, readFile, statfs, open, opendir } = fs;
export type { FileHandle } from 'node:fs/promises';
