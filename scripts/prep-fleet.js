/* eslint-disable */
// @ts-nocheck
'use strict';

const {
  loadEnv,
  config,
  vehicleTopic,
  instantActionsEnvelope,
  shortActionId,
  connect,
  publish,
  collect,
  discoverOnline,
  arg,
} = require('./lib/sim-mqtt');

const DEFAULT_LEVEL = 90;
const DRIFT_TOLERANCE = 2;
const SETTLE_MS = 2500;
const VALUE_FLAGS = ['--host', '--port'];

const USAGE = `Bring the active AGV fleet up: set every battery to a level, then press
"Kích hoạt" (POST /agvs/:id/connect) on each one, exactly like the wes-client UI does.

  node scripts/prep-fleet.js [level] [vehicle...] [options]

  level          0-100, default ${DEFAULT_LEVEL}
  vehicle        serial numbers to narrow the run down, e.g. V01 V07
  --force        also re-connect AGVs the kernel already reports as connected
  --no-verify    skip the battery read-back and the final /agvs re-check
  --host <host>  broker host, default localhost
  --port <port>  broker port, default 1883

Active means: not IGNORED in WES and known to the kernel (kernelStatus
reachable or connected) — the same rows whose UI shows the connect button.
The battery is set before connecting so the charge engine never sees a
low-battery vehicle in the moment it joins the fleet.

Env (all optional):
  WES_BASE_URL             default http://localhost:3000/api
  WES_USER / WES_PASS      default quan.tran / Wes@1234
  MQTT_URL                 overrides --host/--port entirely
  MQTT_USER / MQTT_PASS    default fms / Aubot@2025
  VDA5050_MANUFACTURER     default AUBOT
  VDA5050_INTERFACE_NAME   default aubotagv
  VDA5050_VERSION          default 2.0.0
  DISCOVER_MS              online-vehicle scan window, default 1500
  VERIFY_MS                state read-back window, default 2500

Examples:
  node scripts/prep-fleet.js
  node scripts/prep-fleet.js 45
  node scripts/prep-fleet.js 90 V01 V07 --force
  pnpm prep-fleet`;

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith('-')) continue;
    out.push(args[i]);
  }
  return out;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const free = positionals(args);
  return {
    help: false,
    level: free.length ? Number(free[0]) : DEFAULT_LEVEL,
    vehicles: free.slice(1),
    force: args.includes('--force'),
    verify: !args.includes('--no-verify'),
    host: arg(args, 'host', 'localhost'),
    port: arg(args, 'port', '1883'),
  };
}

function wesConfig() {
  return {
    baseUrl: process.env.WES_BASE_URL || 'http://localhost:3000/api',
    user: process.env.WES_USER || 'quan.tran',
    pass: process.env.WES_PASS || 'Wes@1234',
  };
}

async function login(wes) {
  let res;
  try {
    res = await fetch(`${wes.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: wes.user, password: wes.pass }),
    });
  } catch (err) {
    throw new Error(`cannot reach WES at ${wes.baseUrl}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`login failed (${res.status}) as ${wes.user}`);
  }
  return (await res.json()).token;
}

async function listAgvs(wes, token) {
  const res = await fetch(`${wes.baseUrl}/agvs?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /agvs failed (${res.status})`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.agvs ?? []);
}

function isActive(agv) {
  return (
    agv.acceptanceStatus !== 'IGNORED' &&
    (agv.kernelStatus === 'reachable' || agv.kernelStatus === 'connected')
  );
}

function serialOf(agv) {
  return agv.serialNumber || agv.code || agv.name;
}

function selectTargets(agvs, wanted) {
  const active = agvs.filter(isActive).map((agv) => ({
    agv,
    serial: serialOf(agv),
  }));
  active.sort((a, b) => a.serial.localeCompare(b.serial));
  if (!wanted.length) return active;
  const asked = new Set(wanted);
  return active.filter((t) => asked.has(t.serial) || asked.has(t.agv.name));
}

function setPinPayload(cfg, vehicle, level) {
  return instantActionsEnvelope(cfg, vehicle, [
    {
      actionId: shortActionId('pin'),
      actionType: 'setPinLevel',
      blockingType: 'NONE',
      actionParameters: [{ key: 'pinLevel', value: level }],
    },
  ]);
}

async function readBatteries(client, cfg, serials) {
  const wanted = new Set(serials);
  const seen = new Map();
  await collect(client, vehicleTopic(cfg, '+', 'state'), cfg.verifyMs, (msg) => {
    if (!wanted.has(msg.serialNumber) || !msg.batteryState) return;
    seen.set(msg.serialNumber, msg.batteryState);
  });
  return seen;
}

async function setBatteries(cfg, targets, level, verify) {
  const client = await connect(cfg, 'prep-fleet');
  try {
    const online = new Set(await discoverOnline(client, cfg));
    const reached = targets.filter((t) => online.has(t.serial));
    const offline = targets.filter((t) => !online.has(t.serial));
    for (const target of reached) {
      await publish(
        client,
        vehicleTopic(cfg, target.serial, 'instantActions'),
        setPinPayload(cfg, target.serial, level),
        2,
      );
    }
    const batteries = verify
      ? await readBatteries(
          client,
          cfg,
          reached.map((t) => t.serial),
        )
      : new Map();
    return { reached, offline, batteries };
  } finally {
    client.end(true);
  }
}

async function connectAgv(wes, token, agv) {
  const res = await fetch(`${wes.baseUrl}/agvs/${agv.id}/connect`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.ok) return { ok: true, status: res.status };
  const detail = await res.text().catch(() => '');
  return { ok: false, status: res.status, detail: detail.slice(0, 200) };
}

function batteryNote(battery, level) {
  if (!battery) return 'no state';
  const notes = [`${battery.batteryCharge}%`];
  if (Math.abs(battery.batteryCharge - level) > DRIFT_TOLERANCE) {
    notes.push('off-target');
  }
  if (battery.charging) notes.push('charging, will climb');
  return notes.join(', ');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!Number.isInteger(opts.level) || opts.level < 0 || opts.level > 100) {
    throw new Error(`level must be an integer 0-100, got: ${opts.level}`);
  }

  const wes = wesConfig();
  const token = await login(wes);
  const agvs = await listAgvs(wes, token);
  const targets = selectTargets(agvs, opts.vehicles);
  if (!targets.length) {
    throw new Error(
      `no active AGV among the ${agvs.length} registered in WES` +
        (opts.vehicles.length ? ` matching ${opts.vehicles.join(', ')}` : ''),
    );
  }

  const cfg = config({ host: opts.host, port: opts.port });
  const { reached, offline, batteries } = await setBatteries(
    cfg,
    targets,
    opts.level,
    opts.verify,
  );
  console.log(
    `setPinLevel=${opts.level} sent to ${reached.length}/${targets.length} active AGV(s)`,
  );
  for (const target of offline) {
    console.log(`  ${target.serial}  not ONLINE on ${cfg.url}, battery skipped`);
  }

  const pending = opts.force
    ? targets
    : targets.filter((t) => t.agv.kernelStatus === 'reachable');
  const failures = [];
  for (const target of pending) {
    const result = await connectAgv(wes, token, target.agv);
    if (!result.ok) failures.push({ target, result });
    console.log(
      `  ${target.serial}  connect=${result.status}${result.ok ? '' : `  <-- FAILED ${result.detail}`}`,
    );
  }
  console.log(
    `connect sent to ${pending.length} AGV(s), ` +
      `${targets.length - pending.length} already connected`,
  );

  if (!opts.verify) return;

  await wait(SETTLE_MS);
  const after = await listAgvs(wes, token);
  const byId = new Map(after.map((agv) => [agv.id, agv]));
  const stillOff = [];
  console.log('');
  for (const target of targets) {
    const current = byId.get(target.agv.id);
    const status = current ? current.kernelStatus : 'gone';
    if (status !== 'connected') stillOff.push(target.serial);
    console.log(
      `${target.serial}  ${status}  battery ${batteryNote(batteries.get(target.serial), opts.level)}`,
    );
  }
  const ready = targets.length - stillOff.length;
  console.log(`\n${ready}/${targets.length} active AGV(s) connected`);
  if (failures.length || stillOff.length) {
    throw new Error(
      `not connected: ${stillOff.join(', ') || failures.map((f) => f.target.serial).join(', ')}`,
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
