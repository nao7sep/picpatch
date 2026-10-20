// The versions the TypeScript side states for the managed Python engine: the interpreter uv installs and
// each runtime's own release, recorded in results. The runtimes' pyproject.toml files pin the packages;
// a test checks these against them.
export const pythonVersion = '3.15.0';
export const runtimeVersions = { mflux: '0.22.0', diffusers: '0.41.0', dreamo: '1.1' } as const;
