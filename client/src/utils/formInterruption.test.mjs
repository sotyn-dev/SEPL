import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { transformWithEsbuild } from 'vite';

const require = createRequire(import.meta.url);
async function load(relative, globals = {}, overrides = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8');
  const { code } = await transformWithEsbuild(source, relative, { loader: 'jsx', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports,
    require: name => name in overrides ? overrides[name] : require(name), ...globals });
  return module.exports;
}

test('shared modal ignores outside clicks and retains explicit Close', async () => {
  const { default: Modal } = await load('../components/Modal.jsx');
  let closed = 0;
  const child = { entered: 'unfinished indent' };
  const popup = Modal({ isOpen: true, title: 'Raise indent', children: child, onClose: () => closed++ });
  popup.props.onClick?.({ target: {}, currentTarget: {} });
  assert.equal(closed, 0);
  const panel = popup.props.children;
  assert.equal(panel.props.children[1].props.children, child);
  assert.equal(panel.props.role, 'dialog');
  panel.props.children[0].props.children[1].props.onClick();
  assert.equal(closed, 1);
  assert.equal(Modal({ isOpen: false }), null);
});

test('call notification resumes in place; ordinary notifications still navigate', async () => {
  let message;
  const navigations = [];
  const events = [];
  await load('../lib/push.js', {
    URL,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { location: { origin: 'https://securederp.in', assign: url => navigations.push(url) },
      dispatchEvent: event => events.push(event) },
    navigator: { serviceWorker: { addEventListener: (type, callback) => { message = callback; } } },
  }, { '../api': {} });
  message({ data: { type: 'navigate', url: '/site-chat?call=call-123' } });
  assert.equal(navigations.length, 0, 'must not reload or unmount an unfinished form');
  assert.equal(events[0].type, 'erp:call-notification');
  assert.equal(events[0].detail.callId, 'call-123');
  message({ data: { type: 'navigate', url: '/site-chat?chat=12' } });
  assert.deepEqual(navigations, ['/site-chat?chat=12']);
});
