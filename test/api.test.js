const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// Work on a temporary copy of the seed data so tests never touch agents.json.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallboard-'));
process.env.AGENTS_FILE = path.join(tmpDir, 'agents.json');
fs.writeFileSync(process.env.AGENTS_FILE, JSON.stringify([
  { code: 'A001', name: 'John Doe', status: 'Available' },
  { code: 'A002', name: 'Jane Smith', status: 'Active' },
]));

let app;
before(() => { app = require('../server'); });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('lists agents', async () => {
  const res = await request(app).get('/api/agents');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
});

test('rejects duplicate agent codes with 409', async () => {
  const res = await request(app).post('/api/agents').send({ code: 'A001', name: 'Dup' });
  assert.equal(res.status, 409);
});

test('rejects unknown statuses with 400', async () => {
  const res = await request(app).patch('/api/agents/A001/status').send({ status: 'Sleeping' });
  assert.equal(res.status, 400);
});

test('enforces the status state machine', async () => {
  // Available → Wrap Up is not an allowed transition
  const bad = await request(app).patch('/api/agents/A001/status').send({ status: 'Wrap Up' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.allowedTransitions, ['Active', 'Not Ready', 'Offline']);

  // Available → Active → Wrap Up is allowed
  assert.equal((await request(app).patch('/api/agents/A001/status').send({ status: 'Active' })).status, 200);
  const ok = await request(app).patch('/api/agents/A001/status').send({ status: 'Wrap Up' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'Wrap Up');
});

test('persists changes to the data file', async () => {
  await request(app).post('/api/agents/A002/logout');
  const saved = JSON.parse(fs.readFileSync(process.env.AGENTS_FILE, 'utf8'));
  assert.equal(saved.find((a) => a.code === 'A002').status, 'Offline');
});

test('dashboard stats add up', async () => {
  const res = await request(app).get('/api/dashboard/stats');
  const b = res.body.data.statusBreakdown;
  const sum = Object.values(b).reduce((n, s) => n + s.count, 0);
  assert.equal(sum, res.body.data.total);
});

test('unknown routes return JSON 404', async () => {
  const res = await request(app).get('/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});
