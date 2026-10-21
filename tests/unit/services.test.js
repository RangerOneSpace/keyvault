import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseNetstat, parseTasklist, parseLsof, parseProcNet, groupListeners, demuxDockerLog,
  listContainers, containerAction, containerLogs, composeArgv, dockerStatus,
} from '../../src/services.js';

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1188
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       22140
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9876
  TCP    127.0.0.1:5173         127.0.0.1:61200        ESTABLISHED     9876
  TCP    192.168.1.20:139       0.0.0.0:0              ABHÖREN         4
  TCP    [::]:3000              [::]:0                 LISTENING       22140
  TCP    [::1]:5432             [::]:0                 LISTENING       6420
  TCP    [fe80::1%12]:7680      [::]:0                 LISTENING       5000
  UDP    0.0.0.0:5353           *:*                                    2848
`;

const TASKLIST = `"System Idle Process","0","Services","0","8 K"
"System","4","Services","0","144 K"
"svchost.exe","1188","Services","0","12,340 K"
"com.docker.backend.exe","22140","Console","1","80,000 K"
"node.exe","9876","Console","1","60,000 K"
"postgres.exe","6420","Services","0","9,000 K"`;

test('parses Windows netstat, including non-English state names', () => {
  const rows = parseNetstat(NETSTAT);
  const ports = rows.map(r => `${r.host}:${r.port}/${r.pid}`);
  assert.deepEqual(ports, [
    '0.0.0.0:135/1188', '0.0.0.0:445/4', '0.0.0.0:3000/22140', '127.0.0.1:5173/9876',
    '192.168.1.20:139/4', ':::3000/22140', '::1:5432/6420', 'fe80::1:7680/5000',
  ]);
});

test('groups Windows listeners with process names, exposure and system flag', () => {
  const names = parseTasklist(TASKLIST);
  assert.equal(names.get(9876), 'node.exe');
  const l = groupListeners(parseNetstat(NETSTAT).map(r => ({ ...r, process: names.get(r.pid) || null })));
  const byPort = Object.fromEntries(l.map(x => [x.port, x]));
  assert.deepEqual(byPort[3000].addresses.sort(), ['0.0.0.0', '::'].sort());
  assert.equal(byPort[3000].exposure, 'network');
  assert.equal(byPort[5173].exposure, 'local');
  assert.equal(byPort[5173].process, 'node.exe');
  assert.equal(byPort[5432].exposure, 'local');
  assert.equal(byPort[135].system, true);
  assert.equal(byPort[445].system, true);
  assert.equal(byPort[5173].system, false);
});

test('parses macOS lsof output', () => {
  const out = 'p501\ncnode\nn127.0.0.1:3000\nn[::1]:3000\np88\ncpostgres\nn*:5432\n';
  const l = groupListeners(parseLsof(out));
  assert.equal(l.length, 2);
  assert.equal(l[0].port, 3000); assert.equal(l[0].exposure, 'local'); assert.equal(l[0].process, 'node');
  assert.equal(l[1].port, 5432); assert.equal(l[1].exposure, 'network');
});

test('parses Linux /proc/net/tcp and tcp6', () => {
  const v4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 20 4 30 10 -1`;
  const v6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 55555 1 0000000000000000 100 0 0 10 0`;
  const a = parseProcNet(v4);
  assert.deepEqual(a.map(r => `${r.host}:${r.port}`), ['127.0.0.1:3000', '0.0.0.0:8080']);
  const b = parseProcNet(v6, true);
  assert.deepEqual(b.map(r => `${r.host}:${r.port}`), ['::1:5432', '::' + ':80']);
});

test('demultiplexes Docker log streams', () => {
  const frame = (type, s) => { const b = Buffer.from(s); const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  assert.equal(demuxDockerLog(Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')])), 'hello\noops\n');
  assert.equal(demuxDockerLog(Buffer.from('plain tty output\n')), 'plain tty output\n');
});

test('builds compose arguments with no shell involved (review M1)', () => {
  assert.deepEqual(composeArgv('myapp', '/srv/a/docker-compose.yml,C:\\code\\b\\compose.yaml'),
    ['docker', 'compose', '-p', 'myapp', '-f', '/srv/a/docker-compose.yml', '-f', 'C:\\code\\b\\compose.yaml', 'up', '-d']);
  // A hostile label stays one literal argument; it is never run by a shell.
  assert.deepEqual(composeArgv('p', '/x/$(id>/tmp/pwned).yml').slice(4, 6), ['-f', '/x/$(id>/tmp/pwned).yml']);
  assert.throws(() => composeArgv('p', 'relative.yml'), /unusual/);
  assert.throws(() => composeArgv('p', '/x/a\nb.yml'), /unusual/);
  assert.throws(() => composeArgv('bad name; rm -rf', ''), /Invalid/);
});

test('ignores sockets that are bound but not listening, and flags Docker Desktop', () => {
  const rows = parseNetstat('  TCP    0.0.0.0:50000          0.0.0.0:0              BOUND           1234\n  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       77');
  assert.deepEqual(rows.map(r => r.port), [8080]);
  const g = groupListeners([{ host: '0.0.0.0', port: 8080, pid: 77, process: 'com.docker.backend.exe' }]);
  assert.equal(g[0].dockerProcess, true);
});

test('talks to the Docker Engine API over a socket', { skip: process.platform === 'win32' }, async t => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kv-docker-')), 'docker.sock');
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/version') return res.end(JSON.stringify({ Version: '27.1.0' }));
    if (req.url.startsWith('/containers/json')) {
      return res.end(JSON.stringify([
        { Id: 'a'.repeat(64), Names: ['/shop-web-1'], Image: 'node:22', State: 'running', Status: 'Up 5 minutes', Created: 1700000000,
          Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web', 'com.docker.compose.project.working_dir': '/srv/shop' },
          Ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 8080, Type: 'tcp' }, { IP: '::', PrivatePort: 3000, PublicPort: 8080, Type: 'tcp' }] },
        { Id: 'b'.repeat(64), Names: ['/redis'], Image: 'redis:7', State: 'exited', Status: 'Exited (0) 1 hour ago', Created: 1700000000, Labels: {}, Ports: [] },
      ]));
    }
    if (req.url.startsWith('/containers/redis/start')) { res.statusCode = 204; return res.end(); }
    if (req.url.startsWith('/containers/shop-web-1/logs')) {
      const b = Buffer.from('listening on 3000\n'); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4);
      return res.end(Buffer.concat([h, b]));
    }
    res.statusCode = 404; res.end('{"message":"No such container"}');
  });
  await new Promise(r => server.listen(sock, r));
  t.after(() => server.close());
  process.env.DOCKER_HOST = `unix://${sock}`;
  t.after(() => { delete process.env.DOCKER_HOST; });

  assert.deepEqual(await dockerStatus(), { available: true, version: '27.1.0' });
  const list = await listContainers();
  assert.equal(list.length, 2);
  const web = list.find(c => c.name === 'shop-web-1');
  assert.equal(web.project, 'shop');
  assert.equal(web.workingDir, '/srv/shop');
  assert.deepEqual(web.ports, [{ hostPort: 8080, containerPort: 3000, proto: 'tcp', hosts: ['0.0.0.0', '::'] }]);
  assert.deepEqual(await containerAction('redis', 'start'), { ok: true, changed: true });
  await assert.rejects(containerAction('ghost', 'stop'), /No container/);
  await assert.rejects(containerAction('redis; rm', 'stop'), /Invalid/);
  assert.equal(await containerLogs('shop-web-1', 50), 'listening on 3000\n');
});

test('reports Docker as unavailable when nothing is listening', async t => {
  process.env.DOCKER_HOST = `unix://${path.join(os.tmpdir(), 'kv-no-such.sock')}`;
  t.after(() => { delete process.env.DOCKER_HOST; });
  const s = await dockerStatus();
  assert.equal(s.available, false);
  assert.ok(s.error);
});

test('app icons: only same-server paths or image data URLs are used', async () => {
  const { iconHref } = await import('../../src/services.js');
  assert.equal(iconHref('<link rel="icon" href="/vite.svg">'), '/vite.svg');
  assert.equal(iconHref('<link rel="shortcut icon" href="favicon.png">'), '/favicon.png');
  assert.equal(iconHref('<link rel="icon" href="https://evil.example/x.png">'), '/favicon.ico', 'never another host');
  assert.equal(iconHref('<link rel="icon" href="//evil.example/x.png">'), '/favicon.ico');
  assert.equal(iconHref('<link rel="icon" href="data:text/html,hello">'), null, 'no non-image data URLs');
  assert.match(iconHref('<link rel="icon" href="data:image/png;base64,AAAA">'), /^data:image\/png/);
  assert.equal(iconHref('<title>x</title>'), '/favicon.ico');
});

test('compose project names: capitals and dots from older tools are accepted, flags are not', async () => {
  const { PROJECT_NAME, composeArgv } = await import('../../src/services.js');
  for (const ok of ['northwind', 'Ranger_One_Platform', 'my.app-2']) assert.ok(PROJECT_NAME.test(ok), ok);
  for (const bad of ['-p', '--file=x', '', 'a b', 'a;rm', '../x']) assert.ok(!PROJECT_NAME.test(bad), bad);
  assert.deepEqual(composeArgv('Ranger_One_Platform', ''), ['docker', 'compose', '-p', 'Ranger_One_Platform', 'up', '-d']);
});
