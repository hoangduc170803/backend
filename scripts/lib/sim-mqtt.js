/* eslint-disable */
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

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

function config({ host = 'localhost', port = '1883' } = {}) {
  return {
    url: process.env.MQTT_URL || `mqtt://${host}:${port}`,
    username: process.env.MQTT_USER || 'fms',
    password: process.env.MQTT_PASS || 'Aubot@2025',
    manufacturer: process.env.VDA5050_MANUFACTURER || 'AUBOT',
    interfaceName: process.env.VDA5050_INTERFACE_NAME || 'aubotagv',
    protocolVersion: process.env.VDA5050_VERSION || '2.0.0',
    discoverMs: Number(process.env.DISCOVER_MS || 1500),
    verifyMs: Number(process.env.VERIFY_MS || 2500),
  };
}

function vehicleTopic(cfg, vehicle, suffix) {
  return `${cfg.interfaceName}/${cfg.protocolVersion}/${cfg.manufacturer}/${vehicle}/${suffix}`;
}

function simulationTopic(cfg, vehicle, suffix) {
  return `${cfg.interfaceName}/simulation/${cfg.manufacturer}/${vehicle}/${suffix}`;
}

function instantActionsEnvelope(cfg, vehicle, actions) {
  return JSON.stringify({
    headerId: 1,
    timestamp: new Date().toISOString(),
    version: cfg.protocolVersion,
    manufacturer: cfg.manufacturer,
    serialNumber: vehicle,
    actions,
  });
}

function shortActionId(prefix) {
  const room = 10 - prefix.length;
  return `${prefix}${String(Date.now()).slice(-room)}`;
}

function connect(cfg, clientIdPrefix) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(cfg.url, {
      username: cfg.username,
      password: cfg.password,
      clientId: `${clientIdPrefix}-${process.pid}`,
      connectTimeout: 5000,
      reconnectPeriod: 0,
    });
    client.once('connect', () => resolve(client));
    client.once('error', (err) => {
      client.end(true);
      reject(new Error(`cannot reach MQTT broker at ${cfg.url}: ${err.message || err}`));
    });
  });
}

function publish(client, topic, payload, qos) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos }, (err) => (err ? reject(err) : resolve()));
  });
}

function readLatest(client, topic, windowMs, qos = 1) {
  return new Promise((resolve, reject) => {
    let latest = null;
    const handler = (receivedTopic, raw) => {
      if (receivedTopic !== topic) return;
      try {
        latest = JSON.parse(raw.toString());
      } catch {}
    };
    client.on('message', handler);
    client.subscribe(topic, { qos }, (err) => {
      if (err) {
        client.off('message', handler);
        reject(err);
        return;
      }
      setTimeout(() => {
        client.off('message', handler);
        client.unsubscribe(topic, () => resolve(latest));
      }, windowMs);
    });
  });
}

function collect(client, topic, windowMs, onMessage, qos = 1) {
  return new Promise((resolve, reject) => {
    const handler = (receivedTopic, raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      onMessage(parsed, receivedTopic);
    };
    client.on('message', handler);
    client.subscribe(topic, { qos }, (err) => {
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
  await collect(client, vehicleTopic(cfg, '+', 'connection'), cfg.discoverMs, (msg) => {
    if (!msg.serialNumber) return;
    if (msg.connectionState === 'ONLINE') online.add(msg.serialNumber);
    else online.delete(msg.serialNumber);
  });
  return [...online].sort();
}

function arg(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

module.exports = {
  loadEnv,
  config,
  vehicleTopic,
  simulationTopic,
  instantActionsEnvelope,
  shortActionId,
  connect,
  publish,
  readLatest,
  collect,
  discoverOnline,
  arg,
};
