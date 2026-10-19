import packageInfo from '../package.json' with { type: 'json' };
/** The SDK's own version for a caller consuming it from source; package.json owns the value. */
export const VERSION: string = packageInfo.version;
