#!/usr/bin/env node
import { constants, setPriority } from 'node:os';
import { mcpHelpText } from './crucible-mcp-flags.mjs';
import packageMetadata from '../package.json' with { type: 'json' };

const argumentsValue = process.argv.slice(2);
if (argumentsValue.includes('--help')) {
  console.log(mcpHelpText(packageMetadata.version));
} else if (argumentsValue.length === 1 && argumentsValue[0] === '--version') {
  console.log(packageMetadata.version);
} else if (argumentsValue.length === 1 && argumentsValue[0] === '--check-update') {
  const { runCheckUpdateCli } = await import('../build/mcp/server.mjs');
  await runCheckUpdateCli({ version: packageMetadata.version });
} else {
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
    const { runMcpCli } = await import('../build/mcp/server.mjs');
    await runMcpCli({ argumentsValue, version: packageMetadata.version,
      previewUrl: new URL('../build/mcp/preview.js', import.meta.url),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
