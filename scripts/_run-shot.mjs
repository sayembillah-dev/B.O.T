// wrapper: node scripts/_run-shot.mjs <spec.json> — feeds the JSON spec file to screenshot.mjs
// (cmd quoting mangles inline JSON, so the spec comes via file)
import fs from 'node:fs';
process.argv[2] = fs.readFileSync(process.argv[2] || 'scripts/_shot-chaos.json', 'utf8');
await import('./screenshot.mjs');
