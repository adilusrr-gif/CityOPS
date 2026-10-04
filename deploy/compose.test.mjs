import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('local Compose waits for a responding reverse proxy and CI retains startup failures',()=>{
 const compose=readFileSync(new URL('../compose.enterprise.yaml',import.meta.url),'utf8');
 const proxy=compose.slice(compose.indexOf('\n  proxy:'),compose.indexOf('\nnetworks:'));
 assert.match(proxy,/healthcheck:/);
 assert.match(proxy,/wget -q -O \/dev\/null http:\/\/127\.0\.0\.1:8080\/api\/ready/);
 assert.match(proxy,/retries: 30/);
 const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const diagnostics=workflow.indexOf('Capture disposable Compose diagnostics on failure');
 assert.ok(diagnostics>0&&diagnostics<workflow.indexOf('Shut down disposable integration services'));
 assert.match(workflow.slice(diagnostics),/if: failure\(\)/);
 assert.match(workflow.slice(diagnostics),/logs --no-color --tail=150/);
});
