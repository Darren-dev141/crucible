// Crucible reads each setting from its CRUCIBLE_ name first. The SIXTYSEVENJS_ name from before the rename still works as an alias.
const CURRENT_PREFIX = 'CRUCIBLE_';
const LEGACY_PREFIX = 'SIXTYSEVENJS_';

// `suffix` is the name without its prefix, for example 'MCP_LOG'. An empty value counts as not set, so a blank
// CRUCIBLE_ line in an env file does not hide a working alias.
export function readEnvironmentVariable(suffix, env = process.env) {
  for (const prefix of [CURRENT_PREFIX, LEGACY_PREFIX]) {
    const value = env[prefix + suffix];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}
