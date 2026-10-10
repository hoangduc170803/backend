/* eslint-disable */
// @ts-nocheck
'use strict';

const {
  loadEnv,
  config,
  vehicleTopic,
  simulationTopic,
  instantActionsEnvelope,
  shortActionId,
  connect,
  publish,
  readLatest,
  arg,
} = require('./lib/sim-mqtt');

const ACTION_TYPE = 'clearErrors';
const DEFAULT_VEHICLE = 'V01';

const USAGE = `Clear every error on a simulated AGV via a ${ACTION_TYPE} instantAction.

Resets what scripts/trigger-lost-navigation.js injected, so the same scenario can
be run again. The simulator drops its whole error array, forgets the injected
error type and releases any order it queued while faulted.

  node scripts/clear-vehicle-errors.js [vehicle...] [options]

  vehicle       serial numbers, e.g. V01 V07. Default ${DEFAULT_VEHICLE}
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
  VERIFY_MS                status read-back window, default 2500

Examples:
  node scripts/clear-vehicle-errors.js
  node scripts/clear-vehicle-errors.js V01 V07
  node scripts/clear-vehicle-errors.js --host 171.244.5.185`;

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const flagValues = new Set();
  for (const name of ['host', 'port']) {
    const value = arg(args, name, null);
    if (value !== null) flagValues.add(value);
  }
  const vehicles = args.filter((a) => !a.startsWith('-') && !flagValues.has(a));
  return {
    help: false,
    vehicles: vehicles.length ? vehicles : [DEFAULT_VEHICLE],
    host: arg(args, 'host', 'localhost'),
    port: arg(args, 'port', '1883'),
    verify: !args.includes('--no-verify'),
  };
}

function clearErrorsPayload(cfg, vehicle) {
  return instantActionsEnvelope(cfg, vehicle, [
    {
      actionId: shortActionId('clr'),
      actionType: ACTION_TYPE,
      blockingType: 'NONE',
      actionParameters: [],
    },
  ]);
}

async function clearOne(client, cfg, vehicle) {
  const topic = vehicleTopic(cfg, vehicle, 'instantActions');
  await publish(client, topic, clearErrorsPayload(cfg, vehicle), 2);
  console.log(`topic   ${topic}`);
  console.log(`sent    ${ACTION_TYPE} to ${vehicle}`);
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
  if (status.activeError) {
    return `${vehicle}: still reports activeError=${status.activeError}`;
  }
  console.log(`status  ${vehicle} activeError=none laserActive=${status.laserActive}`);
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
  const client = await connect(cfg, 'clear-errors');
  try {
    console.log(`broker  ${cfg.url}`);
    for (const vehicle of opts.vehicles) {
      await clearOne(client, cfg, vehicle);
    }

    if (!opts.verify) return;
    const failures = [];
    for (const vehicle of opts.vehicles) {
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
