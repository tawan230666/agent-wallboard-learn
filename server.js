// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const Joi = require('joi');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ===== Persistence (agents.json) =====
// AGENTS_FILE lets tests use a throwaway copy instead of the real data file.
const DATA_FILE = path.resolve(process.env.AGENTS_FILE || path.join(__dirname, 'agents.json'));

function loadAgents() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[agents] load fallback (use defaults):', e.message);
    return [
      { code: 'A001', name: 'John Doe',  status: 'Available' },
      { code: 'A002', name: 'Jane Smith',status: 'Active'    },
      { code: 'A003', name: 'Mike Lee',  status: 'Not Ready' }
    ];
  }
}

function saveAgents() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(agents, null, 2));
    fs.renameSync(tmp, DATA_FILE); // atomic-ish
  } catch (e) {
    console.error('[agents] persist error:', e);
    // ไม่ทำให้โปรเซสล้ม — ข้อมูลยังอยู่ในหน่วยความจำ
  }
}

// ใช้ตัวนี้ตัวเดียว
let agents = loadAgents();

// ===== Constants =====
const VALID_STATUSES = ['Available', 'Active', 'Wrap Up', 'Not Ready', 'Offline'];
const ALLOWED_TRANSITIONS = {
  'Available': ['Active', 'Not Ready', 'Offline'],
  'Active': ['Wrap Up', 'Not Ready'],
  'Wrap Up': ['Available', 'Not Ready'],
  'Not Ready': ['Available', 'Offline'],
  'Offline': ['Available']
};
const statusSchema = Joi.object({
  status: Joi.string().valid(...VALID_STATUSES).required()
});

// ===== Middlewares =====
app.use(cors());
app.use(express.json());

// ===== Hour 1: Basic Routes =====
app.get('/', (req, res) => {
  res.send('Hello Agent Wallboard!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// (ตัวเลือก) ตรวจสุขภาพ storage
app.get('/api/storage/health', (req, res) => {
  try {
    fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK);
    res.json({ ok: true, path: DATA_FILE });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, path: DATA_FILE });
  }
});

// ===== Hour 2: Agent Management =====
app.get('/api/agents', (req, res) => {
  res.json({ success: true, data: agents, count: agents.length, timestamp: new Date().toISOString() });
});

app.get('/api/agents/count', (req, res) => {
  res.json({ success: true, count: agents.length, timestamp: new Date().toISOString() });
});

app.get('/api/agents/:code', (req, res) => {
  const agent = agents.find(a => a.code === req.params.code);
  if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
  res.json({ success: true, data: agent });
});

app.post('/api/agents', (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ success: false, error: 'code & name required' });
  if (agents.some(a => a.code === code)) return res.status(409).json({ success: false, error: 'Duplicate code' });

  agents.push({ code, name, status: 'Offline' });
  saveAgents();
  res.status(201).json({ success: true });
});

// ===== Hour 3: Status Management =====
app.patch('/api/agents/:code/status', (req, res) => {
  // Validate body
  const { error, value } = statusSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  const agentCode = req.params.code;
  const newStatus = value.status;

  const agent = agents.find(a => a.code === agentCode);
  if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });

  const oldStatus = agent.status;
  const allowed = ALLOWED_TRANSITIONS[oldStatus] || [];

  if (!allowed.includes(newStatus)) {
    return res.status(400).json({
      success: false,
      error: `Disallowed transition: ${oldStatus} → ${newStatus}`,
      allowedTransitions: allowed
    });
  }

  agent.status = newStatus;
  saveAgents();

  console.log(`[${new Date().toISOString()}] Agent ${agentCode}: ${oldStatus} → ${newStatus}`);
  res.json({ success: true, message: 'Status updated', data: agent });
});

// ===== Hour 4: Dashboard & Mini Project =====
app.get('/api/dashboard/stats', (req, res) => {
  const total = agents.length;
  const countBy = s => agents.filter(a => a.status === s).length;

  const available = countBy('Available');
  const active    = countBy('Active');
  const wrapUp    = countBy('Wrap Up');
  const notReady  = countBy('Not Ready');
  const offline   = countBy('Offline');

  const pct = n => (total > 0 ? Math.round((n / total) * 100) : 0);

  res.json({
    success: true,
    data: {
      total,
      statusBreakdown: {
        available: { count: available, percent: pct(available) },
        active:    { count: active,    percent: pct(active)    },
        wrapUp:    { count: wrapUp,    percent: pct(wrapUp)    },
        notReady:  { count: notReady,  percent: pct(notReady)  },
        offline:   { count: offline,   percent: pct(offline)   }
      },
      timestamp: new Date().toISOString()
    }
  });
});

app.post('/api/agents/:code/login', (req, res) => {
  const agentCode = req.params.code;
  const { name }  = req.body;

  let agent = agents.find(a => a.code === agentCode);
  if (!agent) {
    agent = { code: agentCode, name: name || `Agent ${agentCode}`, status: 'Available', loginTime: new Date().toISOString() };
    agents.push(agent);
  } else {
    if (name) agent.name = name;
    agent.status = 'Available';
    agent.loginTime = new Date().toISOString();
  }
  saveAgents();
  res.json({ success: true, data: agent });
});

app.post('/api/agents/:code/logout', (req, res) => {
  const agent = agents.find(a => a.code === req.params.code);
  if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });

  agent.status = 'Offline';
  delete agent.loginTime;
  saveAgents();

  res.json({ success: true, data: agent });
});

// ===== Fallbacks =====
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not Found' });
});

app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// ===== Start =====
// Only listen when run directly (`node server.js`); tests import the app.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Agent Wallboard server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
