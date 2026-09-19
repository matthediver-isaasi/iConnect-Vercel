#!/usr/bin/env node
// Shell-side I/O helper for the durable sandbox coordinator. It never contacts
// Vercel and never handles a provider credential.
import { resolve } from 'node:path';
import { pollVercelRequestBridge,installVercelBridgeResponse } from './bnms-dd-vercel-connector-bridge.mjs';

const [operation,directory,tempPath,...extra]=process.argv.slice(2);
if(extra.length||!directory||!['poll','install'].includes(operation)||(operation==='install'&&!tempPath))
  throw Error('Usage: bnms-dd-vercel-bridge-io.mjs poll DIR | install DIR TEMP');
if(operation==='poll')console.log(JSON.stringify(await pollVercelRequestBridge(resolve(directory))));
else await installVercelBridgeResponse(resolve(directory),resolve(tempPath));