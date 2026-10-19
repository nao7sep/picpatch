import metadata from '../../package.json' with { type: 'json' };
/** App metadata, never the unpackaged Electron host's name or version. */
export const about = {
  name: metadata.productName,
  version: metadata.version,
  license: metadata.license,
  copyright: '© 2026 Yoshinao Inoguchi',
  repository: 'https://github.com/nao7sep/picpatch',
  issues: 'https://github.com/nao7sep/picpatch/issues',
} as const;
