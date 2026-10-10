/* eslint-disable */
// @ts-nocheck
'use strict';

const {
  loadEnv,
  config,
  simulationTopic,
  connect,
  publish,
  readLatest,
  discoverOnline,
  arg,
} = require('./lib/sim-mqtt');

const COMMAND = 'clearLoad';

const USAGE = `Empty the reported load of a simulated AGV via the ${COMMAND} simulation command.

This is a simulator back door, not VDA5050: it drops state.loads to [] straight
away, without producing an actionState. Use it to reset a sim that is still
reporting cargo after a withdrawn or crashed order. To exercise the real
protocol path, send a liftDown node action through a transport order instead.

  node scripts/clear-load.js [vehicle...] [options]

  vehicle       serial numbers, e.g. V01 V07. Default: every ONLINE vehicle
  --host <host> broker host, default localhost
  --port <port> broker port, default 1883
  --no-verify   skip reading the sim status topic back

Env (all optional):
  MQTT_URL                 overrides --host/--port entirely
  MQTT_USER                default fms
  MQTT_PASS                default Aubot@2025
  VDA5050_MANUFACTURER     default AUBOT
  VDA5050_INTERFACE_NAME   default aubotagv
  VDA5050_VERSION          default 2.0.0
  DISCOVER_MS              online-vehicle scan window, default 1500
  VERIFY_MS                status read-back window, default 2500

Examples:
  node scripts/clear-load.js
  node scripts/clear-load.js V01 V07
  node scripts/clear-load.js --host 171.244.5.185`;

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const flagValues = new Set();
  for (const name of ['host', 'port']) {
    const value = arg(args, name, null);
    if (value !== null) flagValues.add(value);
  }
  return {
    help: false,
    vehicles: args.filter((a) => !a.startsWith('-') && !flagValues.has(a)),
    host: arg(args, 'host', 'localhost'),
    port: arg(args, 'port', '1883'),
    verify: !args.includes('--no-verify'),
  };
}

async function clearOne(client, cfg, vehicle) {
  const topic = simulationTopic(cfg, vehicle, 'control');
  await publish(client, topic, JSON.stringify({ command: COMMAND }), 1);
  console.log(`sent    ${COMMAND} to ${vehicle} on ${topic}`);
}

async function verifyOne(client, cfg, vehicle) {
  const status = await readLatest(
    client,
    simulationTopic(cfg, vehicle, 'status'),
    cfg.verifyMs,
  );
  if (!status) {
    return `${vehicle}: no simulation status — is the AgvSimulator running?`;
  }
  if (status.loaded === undefined) {
    return `${vehicle}: status has no "loaded" field — the AgvSimulator predates clear-load`;
  }
  if (status.loaded) {
    return `${vehicle}: still reports loaded=true`;
  }
  console.log(`status  ${vehicle} loaded=false`);
  return null;
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const cfg = config({ host: opts.host, port: opts.port });
  const client = await connect(cfg, 'clear-load');
  try {
    console.log(`broker  ${cfg.url}`);
    const vehicles = opts.vehicles.length
      ? opts.vehicles
      : await discoverOnline(client, cfg);
    if (!vehicles.length) {
      throw new Error(`no ONLINE vehicle found on ${cfg.url}`);
    }

    for (const vehicle of vehicles) {
      await clearOne(client, cfg, vehicle);
    }

    if (!opts.verify) return;
    const failures = [];
    for (const vehicle of vehicles) {
      const failure = await verifyOne(client, cfg, vehicle);
      if (failure) failures.push(failure);
    }
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    client.end(true);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
