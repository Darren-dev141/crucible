// Lists a catalog folder as if the optional `three` package were not installed. Used by tests/agent-ktx2.test.js.
import Module from 'node:module';

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutThree(request, ...rest) {
  if (request.startsWith('three/examples/jsm/libs/basis/')) {
    throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
  }
  return originalResolve.call(this, request, ...rest);
};

const catalogUrl = new URL('../../../scripts/agent-asset-catalog.mjs', import.meta.url);
const { createAgentAssetCatalog } = await import(catalogUrl.href);
const catalog = await createAgentAssetCatalog(process.argv[2]);
process.stdout.write(JSON.stringify(catalog.list()));
