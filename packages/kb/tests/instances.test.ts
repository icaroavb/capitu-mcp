import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type InstanceProfile,
  getActiveInstance,
  loadInstanceProfiles,
  openKb,
  resolvePassword,
  setActiveInstance,
} from '../src/index.js';

let dir: string;
let openDbs: Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capitu-inst-test-'));
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  openDbs = [];
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows lock; OS cleans temp
  }
});

/** A minimal env with no SAP_* and a controlled instances path. */
function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

function writeInstances(content: unknown): string {
  const p = join(dir, 'instances.json');
  writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

describe('loadInstanceProfiles', () => {
  it('loads and validates a well-formed instances.json', () => {
    const path = writeInstances({
      active: 'qas',
      instances: [
        { name: 'dev', url: 'https://dev.example.com', user: 'U1', client: '100', language: 'PT' },
        { name: 'qas', url: 'https://qas.example.com', user: 'U2', passwordEnv: 'PW_QAS' },
      ],
    });
    const res = loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }));
    expect(res.source).toBe('file');
    expect(res.active).toBe('qas');
    expect(res.instances).toHaveLength(2);
    expect(res.instances[0]).toMatchObject({
      name: 'dev',
      client: '100',
      passwordEnv: 'SAP_PASSWORD',
    });
    expect(res.instances[1]).toMatchObject({ name: 'qas', passwordEnv: 'PW_QAS' });
  });

  it('falls back to a synthesized "env" instance from SAP_* when no file exists', () => {
    const res = loadInstanceProfiles(
      envWith({
        CAPITU_INSTANCES_PATH: join(dir, 'does-not-exist.json'),
        SAP_URL: 'https://env.example.com',
        SAP_USER: 'ENVUSER',
        SAP_CLIENT: '250',
        SAP_LANGUAGE: 'PT',
      }),
    );
    expect(res.source).toBe('env-fallback');
    expect(res.active).toBe('env');
    expect(res.instances).toEqual([
      {
        name: 'env',
        url: 'https://env.example.com',
        user: 'ENVUSER',
        client: '250',
        language: 'PT',
        passwordEnv: 'SAP_PASSWORD',
      },
    ]);
  });

  it('returns an empty list when there is neither a file nor SAP_* env vars', () => {
    const res = loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: join(dir, 'nope.json') }));
    expect(res.source).toBe('empty');
    expect(res.instances).toEqual([]);
  });

  it('throws a clear error on malformed JSON', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not json', 'utf8');
    expect(() => loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: p }))).toThrow(
      /not valid JSON/,
    );
  });

  it('throws when an instance is missing required fields', () => {
    const path = writeInstances({ instances: [{ name: 'x', url: 'https://x' }] }); // no user
    expect(() => loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }))).toThrow(
      /missing "user"/,
    );
  });

  it('throws on duplicate instance names', () => {
    const path = writeInstances({
      instances: [
        { name: 'dup', url: 'https://a', user: 'U' },
        { name: 'dup', url: 'https://b', user: 'U' },
      ],
    });
    expect(() => loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }))).toThrow(
      /duplicated/,
    );
  });
});

describe('active instance pointer (meta table)', () => {
  it('round-trips through get/setActiveInstance', () => {
    const db = openKb({ path: join(dir, 'kb.db') });
    openDbs.push(db);
    expect(getActiveInstance(db)).toBeNull();
    setActiveInstance(db, 'cliente-x');
    expect(getActiveInstance(db)).toBe('cliente-x');
    // upsert: second write overwrites
    setActiveInstance(db, 'cliente-y');
    expect(getActiveInstance(db)).toBe('cliente-y');
  });
});

describe('resolvePassword', () => {
  const profile: InstanceProfile = {
    name: 'p',
    url: 'https://p',
    user: 'U',
    passwordEnv: 'PW_FOR_P',
  };

  it('reads the password from the named env var', () => {
    expect(resolvePassword(profile, envWith({ PW_FOR_P: 's3cret' }))).toBe('s3cret');
  });

  it('throws a semantic error naming the missing variable', () => {
    expect(() => resolvePassword(profile, envWith({}))).toThrow(/PW_FOR_P is unset/);
  });

  it('defaults to SAP_PASSWORD when passwordEnv is absent', () => {
    const p: InstanceProfile = { name: 'q', url: 'https://q', user: 'U' };
    expect(resolvePassword(p, envWith({ SAP_PASSWORD: 'fallback' }))).toBe('fallback');
  });
});
