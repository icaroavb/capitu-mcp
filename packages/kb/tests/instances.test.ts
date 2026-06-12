import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type InstanceProfile,
  getActiveInstance,
  isToolEnabled,
  loadInstanceProfiles,
  openKb,
  resolveBearer,
  resolveCookie,
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

describe('per-instance safety fields', () => {
  it('parses readOnly and allowedPackages', () => {
    const path = writeInstances({
      instances: [
        {
          name: 'prod',
          url: 'https://prod',
          user: 'U',
          readOnly: true,
          allowedPackages: ['Z*', 'Y*'],
        },
      ],
    });
    const res = loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }));
    expect(res.instances[0]).toMatchObject({ readOnly: true, allowedPackages: ['Z*', 'Y*'] });
  });

  it('leaves readOnly undefined when not declared (restrictive default applied by caller)', () => {
    const path = writeInstances({ instances: [{ name: 'x', url: 'https://x', user: 'U' }] });
    const res = loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }));
    expect(res.instances[0]?.readOnly).toBeUndefined();
    expect(res.instances[0]?.allowedPackages).toBeUndefined();
  });

  it('rejects a non-array allowedPackages', () => {
    const path = writeInstances({
      instances: [{ name: 'x', url: 'https://x', user: 'U', allowedPackages: 'Z*' }],
    });
    expect(() => loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }))).toThrow(
      /allowedPackages.*array/,
    );
  });
});

describe('authMode + secret resolvers', () => {
  it('parses a valid authMode and rejects an invalid one', () => {
    const ok = writeInstances({
      instances: [{ name: 'b', url: 'https://b', user: 'U', authMode: 'bearer', bearerEnv: 'TKN' }],
    });
    expect(
      loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: ok })).instances[0]?.authMode,
    ).toBe('bearer');
    const bad = writeInstances({
      instances: [{ name: 'b', url: 'https://b', user: 'U', authMode: 'kerberos' }],
    });
    expect(() => loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: bad }))).toThrow(/authMode/);
  });

  it('resolveCookie prefers cookieString, falls back to cookieFile, else throws', () => {
    const inline: InstanceProfile = {
      name: 'c',
      url: 'https://c',
      user: 'U',
      authMode: 'cookie',
      cookieString: 'SAP_SESSIONID=abc; path=/',
    };
    expect(resolveCookie(inline)).toBe('SAP_SESSIONID=abc; path=/');

    const file = join(dir, 'cookie.txt');
    writeFileSync(file, '  MYSAPSSO2=xyz  \n', 'utf8');
    const fromFile: InstanceProfile = {
      name: 'c',
      url: 'https://c',
      user: 'U',
      authMode: 'cookie',
      cookieFile: file,
    };
    expect(resolveCookie(fromFile)).toBe('MYSAPSSO2=xyz');

    const none: InstanceProfile = { name: 'c', url: 'https://c', user: 'U', authMode: 'cookie' };
    expect(() => resolveCookie(none)).toThrow(/neither cookieString nor/);
  });

  it('resolveBearer returns a fetcher reading the env var at call time', async () => {
    const p: InstanceProfile = {
      name: 'b',
      url: 'https://b',
      user: 'U',
      authMode: 'bearer',
      bearerEnv: 'MY_TOKEN',
    };
    const fetcher = resolveBearer(p, envWith({ MY_TOKEN: 'tok-123' }));
    await expect(fetcher()).resolves.toBe('tok-123');

    const missing = resolveBearer(p, envWith({}));
    await expect(missing()).rejects.toThrow(/MY_TOKEN is unset/);
  });

  it('resolveBearer throws when bearerEnv is not set', () => {
    const p: InstanceProfile = { name: 'b', url: 'https://b', user: 'U', authMode: 'bearer' };
    expect(() => resolveBearer(p, envWith({}))).toThrow(/bearerEnv/);
  });
});

describe('tool visibility map', () => {
  it('parses the root tools map and isToolEnabled honors it', () => {
    const path = writeInstances({
      tools: { capituDevSearch: false, capituDevReadObject: true },
      instances: [{ name: 'x', url: 'https://x', user: 'U' }],
    });
    const res = loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: path }));
    expect(res.tools).toEqual({ capituDevSearch: false, capituDevReadObject: true });
    expect(isToolEnabled('capituDevSearch', res.tools)).toBe(false);
    expect(isToolEnabled('capituDevReadObject', res.tools)).toBe(true);
    // unlisted → enabled by default
    expect(isToolEnabled('capituDevActivate', res.tools)).toBe(true);
  });

  it('isToolEnabled defaults to enabled when the map is absent', () => {
    expect(isToolEnabled('anything', undefined)).toBe(true);
  });
});

describe('Windows User-scope env fallback (winenv)', () => {
  it('parseRegQueryValue extracts REG_SZ and REG_EXPAND_SZ values', async () => {
    const { parseRegQueryValue } = await import('../src/winenv.js');
    const regSz = [
      '',
      'HKEY_CURRENT_USEREnvironment',
      '    SAP_URL    REG_SZ    https://host.example.com:8100',
      '',
    ].join('\r\n');
    expect(parseRegQueryValue(regSz)).toBe('https://host.example.com:8100');

    const expandSz = [
      'HKEY_CURRENT_USEREnvironment',
      '    MY_PATH    REG_EXPAND_SZ    %USERPROFILE%\bin',
    ].join('\r\n');
    expect(parseRegQueryValue(expandSz)).toBe('%USERPROFILE%\bin');

    // Values with internal spaces survive (regex captures to end of line).
    const spaced = '    NOTE    REG_SZ    a value with spaces  ';
    expect(parseRegQueryValue(spaced)).toBe('a value with spaces');
  });

  it('parseRegQueryValue returns undefined for misses and empty values', async () => {
    const { parseRegQueryValue } = await import('../src/winenv.js');
    expect(
      parseRegQueryValue(
        'ERROR: The system was unable to find the specified registry key or value.',
      ),
    ).toBeUndefined();
    expect(parseRegQueryValue('')).toBeUndefined();
    expect(parseRegQueryValue('    EMPTY    REG_SZ    ')).toBeUndefined();
  });

  it('crafted env objects NEVER observe the host registry (test isolation)', () => {
    // envWith() builds a fresh object (≠ process.env), so the User-scope
    // fallback must stay inert: no file + no SAP_URL ⇒ empty, even on a dev
    // machine whose registry HAS SAP_URL. This pins the identity guard.
    const res = loadInstanceProfiles(envWith({ CAPITU_INSTANCES_PATH: join(dir, 'absent.json') }));
    expect(res.source).toBe('empty');
    expect(res.instances).toHaveLength(0);
  });

  it('envValue prefers a direct env value over the registry fallback', async () => {
    const { envValue } = await import('../src/winenv.js');
    expect(envValue(envWith({ CAPITU_KB_PATH: '/explicit/path.db' }), 'CAPITU_KB_PATH')).toBe(
      '/explicit/path.db',
    );
  });

  it('envValue on a crafted (non-process.env) object never hits the registry', async () => {
    const { envValue } = await import('../src/winenv.js');
    // Same identity guard as loadInstanceProfiles above, exercised directly:
    // a var absent from a crafted env resolves to undefined, never the
    // developer machine's registry — regardless of what's actually set there.
    expect(envValue(envWith({}), 'CAPITU_KB_PATH')).toBeUndefined();
    expect(envValue(envWith({}), 'CAPITU_COMPLIANCE_MODE')).toBeUndefined();
    expect(envValue(envWith({}), 'CAPITU_EMBEDDINGS')).toBeUndefined();
    expect(envValue(envWith({}), 'CAPITU_ALLOW_WRITES')).toBeUndefined();
    expect(envValue(envWith({}), 'CAPITU_ALLOWED_PACKAGES')).toBeUndefined();
  });
});

describe('envValue-backed config readers (Desktop-mirroring)', () => {
  it('defaultDbPath: explicit CAPITU_KB_PATH wins, else ~/.capitu/kb.db', async () => {
    const { defaultDbPath } = await import('../src/index.js');
    expect(defaultDbPath(envWith({ CAPITU_KB_PATH: '/custom/kb.db' }))).toBe('/custom/kb.db');
    expect(defaultDbPath(envWith({}))).toMatch(/\.capitu[\\/]kb\.db$/);
  });

  it('loadComplianceFromEnv: reads CAPITU_COMPLIANCE_MODE and the risk ack from a crafted env', async () => {
    const { loadComplianceFromEnv } = await import('../src/index.js');
    expect(loadComplianceFromEnv(envWith({})).mode).toBe('strict');
    expect(loadComplianceFromEnv(envWith({ CAPITU_COMPLIANCE_MODE: 'permissive' })).mode).toBe(
      'permissive',
    );
    expect(
      loadComplianceFromEnv(envWith({ CAPITU_I_UNDERSTAND_API_POLICY_RISK: 'yes' }))
        .riskAcknowledged,
    ).toBe(true);
  });

  it('resolveEmbeddingsProvider: CAPITU_EMBEDDINGS selects the provider from a crafted env', async () => {
    const { resolveEmbeddingsProvider, NullEmbeddings, VoyageEmbeddings } = await import(
      '../src/index.js'
    );
    expect(resolveEmbeddingsProvider(envWith({}))).toBeInstanceOf(NullEmbeddings);
    expect(resolveEmbeddingsProvider(envWith({ CAPITU_EMBEDDINGS: 'bm25' }))).toBeInstanceOf(
      NullEmbeddings,
    );
    expect(resolveEmbeddingsProvider(envWith({ CAPITU_EMBEDDINGS: 'voyage' }))).toBeInstanceOf(
      VoyageEmbeddings,
    );
    expect(resolveEmbeddingsProvider(envWith({ VOYAGE_API_KEY: 'x' }))).toBeInstanceOf(
      VoyageEmbeddings,
    );
  });
});
