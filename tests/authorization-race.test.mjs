import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {hash} from '../src/domain.mjs';

test('in-flight admin PATCH cannot outlive session revocation, role change, or account deactivation', async () => {
  const mutations = [
    {name: 'revoked session', sql: 'DELETE FROM sessions WHERE user_id=\'race-admin\''},
    {name: 'changed role', sql: "UPDATE users SET role='player' WHERE id='race-admin'"},
    {name: 'disabled account', sql: "UPDATE users SET disabled=1 WHERE id='race-admin'"},
  ];
  for (const mutation of mutations) {
    const db = openDb(':memory:', {withSnapshot: false});
    const {server} = createApp({db, env: {NODE_ENV: 'test'}});
    const now = Date.now(), token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run('race-admin', 'race-admin@example.test', 'Admin', 'unused-for-session-test', 'admin', now);
    db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,?)').run(hash(token), 'race-session', 'race-admin', now + 300000, now, now, 0);
    const organization = db.prepare("SELECT * FROM organizations WHERE city_id='astana' ORDER BY id LIMIT 1").get();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let outgoing;
    try {
      const payload = Buffer.from(JSON.stringify({version: organization.version, name: 'Unauthorized delayed edit'}));
      // Observe the first body chunk after the route captured its original user.
      // The remaining bytes are withheld until permissions change, without sleeps.
      const reading = new Promise(resolve => server.once('request', incoming => incoming.once('readable', resolve)));
      const response = new Promise((resolve, reject) => {
        outgoing = httpRequest({hostname: '127.0.0.1', port: server.address().port, method: 'PATCH', path: `/api/manage/organizations/${organization.id}`, headers: {'content-type': 'application/json', 'content-length': payload.length, cookie: `aq_session=${token}`}}, incoming => {
          const chunks = [];
          incoming.on('data', chunk => chunks.push(chunk));
          incoming.on('end', () => resolve({status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString())}));
          incoming.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.write(payload.subarray(0, 1));
      });
      await reading;
      db.exec(mutation.sql);
      outgoing.end(payload.subarray(1));
      const result = await response;
      assert.equal(result.status, 401, mutation.name + ': ' + JSON.stringify(result.body));
      const after = db.prepare('SELECT name,version FROM organizations WHERE id=?').get(organization.id);
      assert.equal(after.name, organization.name, mutation.name);
      assert.equal(after.version, organization.version, mutation.name);
      assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='organization.update'").get().n, 0, mutation.name);
    } finally {
      outgoing?.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  }
});
