import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT_LOCK_ROOT = path.join(tmpdir(), 'local-postgres-test-ports');
const MIN_EPHEMERAL_PORT = 49152;
const MAX_EPHEMERAL_PORT = 65535;

async function reservePort() {
  await mkdir(PORT_LOCK_ROOT, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const port = randomInt(MIN_EPHEMERAL_PORT, MAX_EPHEMERAL_PORT + 1);
    const lock = path.join(PORT_LOCK_ROOT, String(port));
    try {
      await mkdir(lock, { mode: 0o700 });
      return { port, lock };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not reserve an ephemeral port for local PostgreSQL tests');
}

export async function createLocalPostgresHarness(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  let reservation;
  try {
    await mkdir(socket, { mode: 0o700 });
    reservation = await reservePort();
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    root,
    data,
    socket,
    port: reservation.port,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(root, { recursive: true, force: true });
      await rm(reservation.lock, { recursive: true, force: true });
    },
  };
}