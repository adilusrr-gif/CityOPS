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

test('unprivileged local proxy strips unnecessary file capability without relaxing runtime isolation',()=>{
 const compose=readFileSync(new URL('../compose.enterprise.yaml',import.meta.url),'utf8');
 const proxy=compose.slice(compose.indexOf('\n  proxy:'),compose.indexOf('\nnetworks:'));
 assert.match(proxy,/dockerfile: deploy\/local\/Caddy\.Dockerfile/);
 assert.match(proxy,/user: '1000:1000'/);
 assert.match(proxy,/read_only: true/);
 assert.match(proxy,/cap_drop: \[ALL\]/);
 assert.match(proxy,/security_opt: \[no-new-privileges:true\]/);
 assert.doesNotMatch(proxy,/cap_add:|privileged:/);
 const dockerfile=readFileSync(new URL('./local/Caddy.Dockerfile',import.meta.url),'utf8');
 assert.match(dockerfile,/FROM caddy:2\.10\.2-alpine@sha256:[a-f0-9]{64}/);
 assert.match(dockerfile,/RUN setcap -r \/usr\/bin\/caddy && test -z "\$\(getcap \/usr\/bin\/caddy\)"/);
 assert.match(dockerfile,/USER 1000:1000/);
 const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 assert.match(workflow,/test -z "\$\(getcap \/usr\/bin\/caddy\)"/);
 assert.match(workflow,/CapBnd:/);
 assert.match(workflow,/NoNewPrivs:/);
});
