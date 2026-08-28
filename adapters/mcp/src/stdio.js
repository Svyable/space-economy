#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Clearinghouse } from '../../../src/clearinghouse.js';
import { createSpaceEconomyMcpServer } from './server.js';

const statePath = process.env.STATE_PATH ?? './data/state.json';
const market = await Clearinghouse.open({ statePath });

await serveStdio(() => createSpaceEconomyMcpServer({ market }));
