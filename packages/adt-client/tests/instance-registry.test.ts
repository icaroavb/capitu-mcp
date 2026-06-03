import { describe, expect, it } from 'vitest';
import {
  InstanceRegistry,
  type RegistryBridge,
  type RegistryProfile,
} from '../src/instance-registry.js';

/**
 * Registry tests use a fake bridge holding active-state in a local variable
 * (standing in for the KB `meta` table) and a trivial password resolver. No
 * network: active()/switchTo() build CapituAdtClient instances but never call
 * connect().
 */

const PROFILES: RegistryProfile[] = [
  { name: 'dev', url: 'https://dev.s4hana.cloud.sap', user: 'U1', client: '100' },
  { name: 'qas', url: 'https://qas.example.com', user: 'U2', client: '200', edition: 'on-prem' },
];

function makeBridge(initial: string | null = null): {
  bridge: RegistryBridge;
  passwords: string[];
} {
  let active = initial;
  const passwords: string[] = [];
  const bridge: RegistryBridge = {
    getActive: () => active,
    setActive: (n) => {
      active = n;
    },
    resolvePassword: (p) => {
      passwords.push(p.name);
      return `pw-for-${p.name}`;
    },
  };
  return { bridge, passwords };
}

describe('InstanceRegistry', () => {
  it('activeName falls back to the first profile when meta is unset', () => {
    const { bridge } = makeBridge(null);
    const reg = new InstanceRegistry(PROFILES, bridge);
    expect(reg.activeName()).toBe('dev');
  });

  it('activeName honors the stored value when it names a known instance', () => {
    const { bridge } = makeBridge('qas');
    const reg = new InstanceRegistry(PROFILES, bridge);
    expect(reg.activeName()).toBe('qas');
  });

  it('activeName ignores a stale stored value that no longer exists', () => {
    const { bridge } = makeBridge('deleted-instance');
    const reg = new InstanceRegistry(PROFILES, bridge);
    expect(reg.activeName()).toBe('dev'); // falls back to first
  });

  it('active() returns the client for the active instance and caches it', () => {
    const { bridge, passwords } = makeBridge('dev');
    const reg = new InstanceRegistry(PROFILES, bridge);
    const c1 = reg.active();
    const c2 = reg.active();
    expect(c1).toBe(c2); // same cached instance
    expect(c1.url).toBe('https://dev.s4hana.cloud.sap');
    expect(c1.user).toBe('U1');
    expect(passwords).toEqual(['dev']); // password resolved exactly once
  });

  it('switchTo changes the active client and persists via the bridge', async () => {
    const { bridge } = makeBridge('dev');
    const reg = new InstanceRegistry(PROFILES, bridge);
    const devClient = reg.active();
    const summary = await reg.switchTo('qas');
    expect(summary.name).toBe('qas');
    expect(bridge.getActive()).toBe('qas');
    const qasClient = reg.active();
    expect(qasClient).not.toBe(devClient);
    expect(qasClient.url).toBe('https://qas.example.com');
  });

  it('active() reacts to an out-of-band switch (another process changed meta)', () => {
    const { bridge } = makeBridge('dev');
    const reg = new InstanceRegistry(PROFILES, bridge);
    const devClient = reg.active();
    // Simulate docs-mcp switching the shared pointer:
    bridge.setActive('qas');
    const next = reg.active();
    expect(next).not.toBe(devClient);
    expect(next.url).toBe('https://qas.example.com');
  });

  it('switchTo rejects an unknown instance with a helpful message', async () => {
    const { bridge } = makeBridge('dev');
    const reg = new InstanceRegistry(PROFILES, bridge);
    await expect(reg.switchTo('nope')).rejects.toThrow(/Unknown instance "nope".*dev, qas/);
  });

  it('list() returns non-secret summaries and never resolves passwords', () => {
    const { bridge, passwords } = makeBridge('qas');
    const reg = new InstanceRegistry(PROFILES, bridge);
    const list = reg.list();
    expect(list).toHaveLength(2);
    const qas = list.find((i) => i.name === 'qas');
    const dev = list.find((i) => i.name === 'dev');
    expect(qas?.isActive).toBe(true);
    expect(dev?.isActive).toBe(false);
    // edition: explicit on qas, inferred from URL on dev (.s4hana.cloud.sap → pce)
    expect(qas?.edition).toBe('on-prem');
    expect(dev?.edition).toBe('pce');
    // no password key anywhere in the summary
    expect(JSON.stringify(list)).not.toMatch(/pw-for-/);
    expect(passwords).toEqual([]); // listing never touches passwords
  });

  it('hasInstances reflects whether any profile is configured', () => {
    const { bridge } = makeBridge(null);
    expect(new InstanceRegistry(PROFILES, bridge).hasInstances).toBe(true);
    expect(new InstanceRegistry([], bridge).hasInstances).toBe(false);
  });

  it('activeName throws when no instances are configured', () => {
    const { bridge } = makeBridge(null);
    const reg = new InstanceRegistry([], bridge);
    expect(() => reg.activeName()).toThrow(/No SAP instances configured/);
  });
});

describe('InstanceRegistry auth modes + safety', () => {
  const AUTH_PROFILES: RegistryProfile[] = [
    { name: 'basic', url: 'https://b', user: 'U', authMode: 'basic' },
    { name: 'cook', url: 'https://c', user: 'U', authMode: 'cookie' },
    { name: 'bear', url: 'https://br', user: 'U', authMode: 'bearer' },
  ];

  function authBridge(active: string): RegistryBridge {
    return {
      getActive: () => active,
      setActive: () => {},
      resolvePassword: () => 'pw',
      resolveCookie: () => 'SAP_SESSIONID=abc',
      resolveBearer: () => async () => 'tok',
    };
  }

  it('builds a basic-auth client (password resolved)', () => {
    const reg = new InstanceRegistry(AUTH_PROFILES, authBridge('basic'));
    const c = reg.active();
    expect(c.url).toBe('https://b');
  });

  it('builds a cookie-auth client without resolving a password', () => {
    let pwCalls = 0;
    const bridge: RegistryBridge = {
      ...authBridge('cook'),
      resolvePassword: () => {
        pwCalls++;
        return 'pw';
      },
    };
    const reg = new InstanceRegistry(AUTH_PROFILES, bridge);
    const c = reg.active();
    expect(c.url).toBe('https://c');
    expect(pwCalls).toBe(0); // cookie mode never touches the password resolver
  });

  it('builds a bearer-auth client without resolving a password', () => {
    let pwCalls = 0;
    const bridge: RegistryBridge = {
      ...authBridge('bear'),
      resolvePassword: () => {
        pwCalls++;
        return 'pw';
      },
    };
    const reg = new InstanceRegistry(AUTH_PROFILES, bridge);
    const c = reg.active();
    expect(c.url).toBe('https://br');
    expect(pwCalls).toBe(0);
  });

  it('throws when cookie mode is used but no cookie resolver is wired', () => {
    const bridge: RegistryBridge = {
      getActive: () => 'cook',
      setActive: () => {},
      resolvePassword: () => 'pw',
      // no resolveCookie
    };
    const reg = new InstanceRegistry(AUTH_PROFILES, bridge);
    expect(() => reg.active()).toThrow(/cookie.*resolver/i);
  });

  it('exposes the active instance declared safety via activeSafety()', () => {
    const profiles: RegistryProfile[] = [
      { name: 'ro', url: 'https://ro', user: 'U', readOnly: true, allowedPackages: ['Z*'] },
      { name: 'rw', url: 'https://rw', user: 'U', readOnly: false },
      { name: 'def', url: 'https://def', user: 'U' }, // no readOnly declared
    ];
    const mk = (active: string): RegistryBridge => ({
      getActive: () => active,
      setActive: () => {},
      resolvePassword: () => 'pw',
    });
    expect(new InstanceRegistry(profiles, mk('ro')).activeSafety()).toEqual({
      readOnlyDeclared: true,
      allowedPackages: ['Z*'],
    });
    expect(new InstanceRegistry(profiles, mk('rw')).activeSafety()).toEqual({
      readOnlyDeclared: false,
      allowedPackages: undefined,
    });
    expect(new InstanceRegistry(profiles, mk('def')).activeSafety()).toEqual({
      readOnlyDeclared: undefined,
      allowedPackages: undefined,
    });
  });

  it('list() surfaces authMode and readOnly', () => {
    const reg = new InstanceRegistry(AUTH_PROFILES, authBridge('basic'));
    const list = reg.list();
    expect(list.find((i) => i.name === 'cook')?.authMode).toBe('cookie');
    expect(list.find((i) => i.name === 'bear')?.authMode).toBe('bearer');
  });
});
