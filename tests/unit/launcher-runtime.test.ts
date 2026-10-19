import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

// The launcher helper is plain ESM because both shell families execute it directly.
// @ts-expect-error The directly executed .mjs helper intentionally has no declaration file.
import { claimRuntime, isRuntimeOwner, ownsProcess, parsePosixProcesses, parseWindowsProcesses, releaseRuntime, REPO_ROOT } from "../../scripts/launcher-runtime.mjs";

// The process listings each platform's tool prints, read on every host; the
// native ps, PowerShell and taskkill calls run in the Windows live lane.
describe("launcher process listings", () => {
  it("reads ps output, skipping lines it cannot parse", () => {
    expect(parsePosixProcesses("  10     1 /Applications/PicPatch.app/Contents/MacOS/PicPatch --flag\n\nnot a row\n 11 10 uv sync\n")).toEqual([
      { pid: 10, parentPid: 1, executablePath: "", commandLine: "/Applications/PicPatch.app/Contents/MacOS/PicPatch --flag" },
      { pid: 11, parentPid: 10, executablePath: "", commandLine: "uv sync" },
    ]);
  });

  it("reads PowerShell's process list, a lone process and processes it cannot inspect", () => {
    expect(parseWindowsProcesses(JSON.stringify([
      { ProcessId: 20, ParentProcessId: 4, ExecutablePath: "C:\\PicPatch\\PicPatch.exe", CommandLine: "\"C:\\PicPatch\\PicPatch.exe\"" },
      { ProcessId: 4, ParentProcessId: 0, ExecutablePath: null, CommandLine: null },
    ]))).toEqual([
      { pid: 20, parentPid: 4, executablePath: "C:\\PicPatch\\PicPatch.exe", commandLine: "\"C:\\PicPatch\\PicPatch.exe\"" },
      { pid: 4, parentPid: 0, executablePath: "", commandLine: "" },
    ]);
    expect(parseWindowsProcesses(`${JSON.stringify({ ProcessId: 30, ParentProcessId: 20, ExecutablePath: "C:\\uv.exe", CommandLine: "uv" })}\r\n`)).toEqual([
      { pid: 30, parentPid: 20, executablePath: "C:\\uv.exe", commandLine: "uv" },
    ]);
    expect(parseWindowsProcesses("")).toEqual([]);
  });
});

describe("launcher process identity", () => {
  const identity = { kind: "electron", label: "PicPatch", executable: "PicPatch" };

  it("owns only this repository's PicPatch runtime", () => {
    expect(ownsProcess({
      pid: 10,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 11,
      parentPid: 1,
      executablePath: `${REPO_ROOT}/dist/mac-arm64/PicPatch.app/Contents/MacOS/PicPatch`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 12,
      parentPid: 1,
      executablePath: `${REPO_ROOT}\\dist\\win-unpacked\\PicPatch.exe`,
      commandLine: "",
    }, identity)).toBe(true);
    expect(ownsProcess({
      pid: 13,
      parentPid: 1,
      executablePath: "/another/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      commandLine: "",
    }, identity)).toBe(false);
  });

  it("does not let a stale launcher generation clean up its replacement", async () => {
    const first = `first-${randomUUID()}`;
    const second = `second-${randomUUID()}`;
    try {
      await claimRuntime(first);
      await claimRuntime(second);
      expect(await isRuntimeOwner(first)).toBe(false);
      expect(await isRuntimeOwner(second)).toBe(true);
    } finally {
      await releaseRuntime(second);
    }
  });
});
