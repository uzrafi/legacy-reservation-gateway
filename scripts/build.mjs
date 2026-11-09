/* global console */
// Bundles each Lambda with esbuild into dist/<name>/index.js (Terraform zips these).
// The AWS SDK v3 is provided by the nodejs22.x runtime, so it is left external.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';

const entries = {
  fares: 'src/handlers/fares.ts',
  seatmaps: 'src/handlers/seatmaps.ts',
  holds: 'src/handlers/holds.ts',
  tickets: 'src/handlers/tickets.ts',
  'ticket-worker': 'src/handlers/ticket-worker.ts',
  authorizer: 'src/handlers/authorizer.ts',
  'fare-loader': 'src/handlers/fare-loader.ts',
  legacy: 'src/legacy/lambda.ts',
  // Standalone legacy host for Docker (fully bundled, no Lambda runtime needed).
  'legacy-server': 'src/local/run-legacy.ts',
};

rmSync('dist', { recursive: true, force: true });
for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    sourcemap: 'linked',
    external: name === 'legacy-server' ? [] : ['@aws-sdk/*'],
    logLevel: 'warning',
  });
  if (name === 'legacy' || name === 'legacy-server') {
    mkdirSync(`dist/${name}`, { recursive: true });
    copyFileSync('src/legacy/reslink.wsdl', `dist/${name}/reslink.wsdl`);
  }
  console.log(`${name.padEnd(14)} ${(statSync(`dist/${name}/index.js`).size / 1024).toFixed(0)} KiB`);
}
