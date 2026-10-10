#!/usr/bin/env node
'use strict';
process.env.TS_NODE_PROJECT = 'tsconfig.migrations.json';
require('../../node_modules/typeorm/cli-ts-node-commonjs');
