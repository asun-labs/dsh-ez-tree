import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json')))
const importAndVerify = String.raw`
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
const [entry, packagePath] = process.argv.slice(1);
const plugin = await import(entry);
assert.equal(typeof plugin.apply, 'function');
const routes = [], effects = [], definitions = new Map();
let provider;
const skills = {
  registerProvider(create) { provider = create({ signal: new AbortController().signal, invalidate() {} }); return () => {} },
  async list(options = {}) { return provider ? provider.list(options) : [] },
};
const workspace = join(process.cwd(), 'workspace');
await mkdir(workspace);
const agent = { id: 'packed-resource-session' };
const services = { skills, tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
  workingDirectory: { ensure: async () => workspace } };
const owner = { principal: { kind: 'owner' } };
const ctx = { get: name => services[name], connection: { admit: () => ({ peer: owner }) },
  webServer: { register(route) { routes.push(route); return () => {} } },
  inject() {}, logger: { warn() {}, info() {} }, effect(create) { const dispose = create(); if (typeof dispose === 'function') effects.push(dispose) } };
plugin.apply(ctx);
try {
  assert.ok(definitions.has('ez_tree_open_editor'));
  assert.ok(provider, 'Bundled skill provider not registered');
  const candidates = await provider.list({});
  const skill = await provider.get(candidates.find(value => value.name === 'ez-tree'), {});
  assert.match(skill.content, /ez_tree_open_editor/);
  const actualRoot = await realpath(packagePath);
  assert.ok((await realpath(skill.path)).toLowerCase().startsWith((actualRoot + sep).toLowerCase()), 'Skill reads outside the packed product');
  const rpc = routes.find(route => route.path === '/dsh-ez-tree');
  async function call(method, payload) {
    const chunks = [];
    const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } });
    response.writeHead = status => { response.status = status };
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'pack-proof', method, payload }))]),
      { method: 'POST', url: '/dsh-ez-tree/' + method, headers: { 'content-type': 'application/json' } });
    await rpc.handler(request, response, owner);
    assert.equal(response.status, 200);
    const result = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(result.result.ok, true, result.result.error?.message);
    return result.result.value;
  }
  const opening = definitions.get('ez_tree_open_editor').execute({}, { agent, signal: new AbortController().signal });
  opening.catch(() => {});
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await call('editorRead', { sessionId: agent.id });
    if (state.command) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(state.command);
  const launch = await call('editorBrowserLaunch', { sessionId: agent.id });
  const url = new URL(launch.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('bootstrap');
  url.hash = '';
  const index = await fetch(url);
  assert.equal(index.status, 200);
  const html = await index.text();
  const script = html.match(/<script[^>]*\bsrc=["']([^"']+)["']/)?.[1];
  assert.ok(script, 'Packed editor has no executable entry');
  const module = await fetch(new URL(script, url));
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.ok((await module.arrayBuffer()).byteLength > 1000);
  const redeem = await fetch(new URL('./api/redeem', url), { method: 'POST',
    headers: { origin: url.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(redeem.status, 200);
  const cookie = redeem.headers.get('set-cookie').split(';')[0];
  const command = state.command;
  const ack = await fetch(new URL('./api/ack', url), { method: 'POST',
    headers: { origin: url.origin, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ operationId: command.operationId, revision: command.project.revision,
      optionsDigest: command.project.optionsDigest, metrics: { vertexCount: 1000, triangleCount: 800 } }) });
  assert.equal(ack.status, 200, await ack.text());
  assert.equal(JSON.parse(await opening).rendered, true);
  console.log(JSON.stringify({ import: 'passed', skill: skill.name, editor: 'passed', toolCount: definitions.size }));
} finally {
  for (const dispose of effects.reverse()) await dispose();
}
`

async function staging(t) {
  const directory = await realpath(tmpdir())
  const value = await mkdtemp(join(directory, 'ez-tree-packed-host-'))
  t.after(async () => {
    assert.equal(dirname(resolve(value)), directory)
    assert.ok(basename(value).startsWith('ez-tree-packed-host-'))
    await rm(value, { recursive: true, force: true })
  })
  return value
}

async function verify(entry, packagePath, cwd) {
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', importAndVerify, pathToFileURL(entry).href, packagePath],
    { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1', DSH_HOME: join(cwd, 'isolated-home') } })
  const result = JSON.parse(stdout.trim())
  assert.equal(result.import, 'passed')
  assert.equal(result.skill, 'ez-tree')
  assert.equal(result.editor, 'passed')
}

test('built Host imports from a fresh process and resolves only package-owned skill/editor resources', async t => {
  const cwd = await staging(t)
  await verify(resolve(root, manifest.main), root, cwd)
})

test('actual release tgz Host imports and serves embedded resources away from the checkout', async t => {
  const archive = process.env.DSH_EZ_TREE_VERIFY_ARCHIVE ? resolve(process.env.DSH_EZ_TREE_VERIFY_ARCHIVE)
    : join(root, 'dist', 'dsh-ez-tree-' + manifest.version + '.tgz')
  try { await access(archive) } catch (error) {
    if (error.code === 'ENOENT' && !process.env.DSH_EZ_TREE_VERIFY_ARCHIVE) {
      t.skip('Run pack:release or set DSH_EZ_TREE_VERIFY_ARCHIVE for exact release verification')
      return
    }
    throw error
  }
  const cwd = await staging(t), extracted = join(cwd, 'extracted')
  await mkdir(extracted)
  await run('tar', ['-xf', archive, '-C', extracted], { windowsHide: true, timeout: 30000 })
  const packagePath = join(extracted, 'package')
  const packedManifest = JSON.parse(await readFile(join(packagePath, 'package.json')))
  assert.equal(packedManifest.name, manifest.name)
  assert.equal(packedManifest.version, manifest.version)
  await verify(resolve(packagePath, packedManifest.main), packagePath, cwd)
})

