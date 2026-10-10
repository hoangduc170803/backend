/* eslint-disable */
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const DEFAULT_LEVEL = 90;
const DRIFT_TOLERANCE = 2;

const USAGE = `Set the simulated battery level of VDA5050 AGVs via a setPinLevel instantAction.

  node scripts/set-pin.js [level] [vehicle...] [--no-verify]

  level      0-100, default ${DEFAULT_LEVEL}
  vehicle    serial numbers, e.g. V01 V02. Default: every ONLINE vehicle.
  --no-verify  skip reading /state back after publishing

Env (all optional):
  MQTT_URL                default mqtt://localhost:1883
  MQTT_USER               default fms
  MQTT_PASS               default Aubot@2025
  VDA5050_MANUFACTURER    default AUBOT
  VDA5050_TOPIC_PREFIX    default aubotagv/v2
  DISCOVER_MS             online-vehicle scan window, default 1500
  VERIFY_MS               state read-back window, default 2500

Examples:
  node scripts/set-pin.js
  node scripts/set-pin.js 35
  node scripts/set-pin.js 19 V01 V07
  pnpm set-pin -- 35`;

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const positional = args.filter((a) => !a.startsWith('-'));
  const level = positional.length ? Number(positional[0]) : DEFAULT_LEVEL;
  return {
    help: false,
    level,
    vehicles: positional.slice(1),
    verify: !args.includes('--no-verify'),
  };
}

function config() {
  return {
    url: process.env.MQTT_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_USER || 'fms',
    password: process.env.MQTT_PASS || 'Aubot@2025',
    manufacturer: process.env.VDA5050_MANUFACTURER || 'AUBOT',
    prefix: process.env.VDA5050_TOPIC_PREFIX || 'aubotagv/2.0.0',
    discoverMs: Number(process.env.DISCOVER_MS || 1500),
    verifyMs: Number(process.env.VERIFY_MS || 2500),
  };
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(cfg.url, {
      username: cfg.username,
      password: cfg.password,
      clientId: `set-pin-${process.pid}`,
      connectTimeout: 5000,
      reconnectPeriod: 0,
    });
    client.once('connect', () => resolve(client));
    client.once('error', (err) => {
      client.end(true);
      reject(err);
    });
  });
}

function collect(client, topic, windowMs, onMessage) {
  return new Promise((resolve, reject) => {
    const handler = (receivedTopic, payload) => {
      let parsed;
      try {
        parsed = JSON.parse(payload.toString());
      } catch {
        return;
      }
      onMessage(parsed);
    };
    client.on('message', handler);
    client.subscribe(topic, { qos: 0 }, (err) => {
      if (err) {
        client.off('message', handler);
        reject(err);
        return;
      }
      setTimeout(() => {
        client.off('message', handler);
        client.unsubscribe(topic, () => resolve());
      }, windowMs);
    });
  });
}

async function discoverOnline(client, cfg) {
  const online = new Set();
  await collect(
    client,
    `${cfg.prefix}/${cfg.manufacturer}/+/connection`,
    cfg.discoverMs,
    (msg) => {
      if (!msg.serialNumber) return;
      if (msg.connectionState === 'ONLINE') online.add(msg.serialNumber);
      else online.delete(msg.serialNumber);
    },
  );
  return [...online].sort();
}

function instantActions(cfg, vehicle, level) {
  return JSON.stringify({
    headerId: 1,
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    manufacturer: cfg.manufacturer,
    serialNumber: vehicle,
    actions: [
      {
        actionId: `setpin-${vehicle}-${Date.now()}`,
        actionType: 'setPinLevel',
        blockingType: 'NONE',
        actionParameters: [{ key: 'pinLevel', value: level }],
      },
    ],
  });
}

function publish(client, topic, payload) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: 2 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function readBatteries(client, cfg, vehicles) {
  const wanted = new Set(vehicles);
  const seen = new Map();
  await collect(
    client,
    `${cfg.prefix}/${cfg.manufacturer}/+/state`,
    cfg.verifyMs,
    (msg) => {
      if (!wanted.has(msg.serialNumber) || !msg.batteryState) return;
      seen.set(msg.serialNumber, msg.batteryState);
    },
  );
  return seen;
}

function report(vehicles, batteries, level) {
  const missing = [];
  for (const vehicle of vehicles) {
    const battery = batteries.get(vehicle);
    if (!battery) {
      missing.push(vehicle);
      console.log(`${vehicle}  no state received`);
      continue;
    }
    const charge = battery.batteryCharge;
    const notes = [];
    if (Math.abs(charge - level) > DRIFT_TOLERANCE) notes.push('off-target');
    if (battery.charging) notes.push('charging, will climb');
    console.log(
      `${vehicle}  ${charge}%${notes.length ? `  (${notes.join('; ')})` : ''}`,
    );
  }
  return missing;
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

  const cfg = config();
  const client = await connect(cfg);
  try {
    const vehicles = opts.vehicles.length
      ? opts.vehicles
      : await discoverOnline(client, cfg);
    if (!vehicles.length) {
      throw new Error(
        `no ONLINE vehicle found on ${cfg.url} under ${cfg.prefix}/${cfg.manufacturer}`,
      );
    }

    for (const vehicle of vehicles) {
      await publish(
        client,
        `${cfg.prefix}/${cfg.manufacturer}/${vehicle}/instantActions`,
        instantActions(cfg, vehicle, opts.level),
      );
    }
    console.log(
      `setPinLevel=${opts.level} sent to ${vehicles.length} vehicle(s): ${vehicles.join(', ')}`,
    );

    if (!opts.verify) return;
    const batteries = await readBatteries(client, cfg, vehicles);
    const missing = report(vehicles, batteries, opts.level);
    if (missing.length) {
      throw new Error(`no state read back from: ${missing.join(', ')}`);
    }
  } finally {
    client.end(true);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
