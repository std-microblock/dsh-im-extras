// Runs the bundled VM runtime (built from src/vm/) inside a real quickjs-wasi VM with a recording fake host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib';
import { QuickJS } from 'quickjs-wasi';
import { buildVmRuntime } from '../scripts/build-vm.mjs';

const require = createRequire(import.meta.url);
const wasm = new WebAssembly.Module(readFileSync(require.resolve('quickjs-wasi/quickjs.wasm')));
const RUNTIME = await buildVmRuntime();

type Call = { op: string; payload: string };
type Node = { t: string; a: Record<string, unknown>; c: Node[] };

/** Fake host: records `__host` calls; `agentReply` answers the 'agent' op. */
class Harness {
  vm: any;
  calls: Call[] = [];
  agentReply = '{"ok":true}';
  /** The card's data folder, in memory. */
  files = new Map<string, string>();
  /** What the next 'fetch' op answers (`{ ok, error }` refuses it). */
  fetchReply = '';
  /** Optional handler for host 'action' calls. */
  actionHandler?: (name: string, payload: unknown) => unknown;
  /** Bodies of the requests the card sent. */
  requests: { url: string; method?: string; headers?: Record<string, string>; body?: string }[] = [];

  static async create(card: string): Promise<Harness> {
    const h = new Harness();
    h.vm = await QuickJS.create({ wasm });
    const fn = h.vm.newFunction('__host', h.hostFn());
    h.vm.setProp(h.vm.global, '__host', fn);
    fn.dispose();
    h.eval(RUNTIME, 'runtime.js');
    h.eval(card, 'card.js');
    h.eval(`__card.mount(globalThis.Card, '{}')`);
    return h;
  }

  hostFn() {
    return (op: any, payload: any) => {
      const call = { op: op.toString(), payload: payload.toString() };
      this.calls.push(call);
      if (call.op === 'fs') return this.vm.newString(JSON.stringify(this.fileReply(JSON.parse(call.payload))));
      if (call.op === 'fetch') {
        if (this.fetchReply !== '') return this.vm.newString(this.fetchReply);
        this.requests.push(JSON.parse(call.payload));
        return this.vm.newString(JSON.stringify({ ok: true, id: `r${this.requests.length}` }));
      }
      if (call.op === 'action') {
        const parsed = JSON.parse(call.payload) as { name: string; payload: unknown };
        const result = this.actionHandler ? this.actionHandler(parsed.name, parsed.payload) : { ok: false, error: 'no action handler' };
        return this.vm.newString(JSON.stringify(result));
      }
      return this.vm.newString(call.op === 'agent' ? this.agentReply : '');
    };
  }

  /** The data folder: the same refusals the real host makes, over a map. */
  fileReply(request: { op: string; path: string; text?: string }): { ok: boolean; value?: unknown; error?: string } {
    const path = String(request.path);
    if (path.startsWith('/') || path.split('/').includes('..')) {
      return { ok: false, error: `path escapes the card folder: ${path}` };
    }
    switch (request.op) {
      case 'read': return { ok: true, value: this.files.get(path) };
      case 'write': this.files.set(path, String(request.text ?? '')); return { ok: true };
      case 'append': this.files.set(path, (this.files.get(path) ?? '') + String(request.text ?? '')); return { ok: true };
      case 'remove': this.files.delete(path); return { ok: true };
      case 'stat': return { ok: true, value: this.files.has(path) };
      case 'list': {
        const prefix = path === '' ? '' : `${path}/`;
        const names = new Set<string>();
        for (const key of this.files.keys()) {
          if (!key.startsWith(prefix)) continue;
          names.add(key.slice(prefix.length).split('/')[0]!);
        }
        return {
          ok: true,
          value: [...names].map(name => {
            const text = this.files.get(`${prefix}${name}`);
            return { name, dir: text === undefined, size: text === undefined ? 0 : text.length };
          }),
        };
      }
      default: return { ok: false, error: `unknown file operation ${request.op}` };
    }
  }

  /** Settle request `id` inside the VM, as the host does when an answer arrives. */
  settle(id: string, result: unknown): { found: boolean } {
    const reply = JSON.parse(this.eval(`__card.settleFetch(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(result))})`));
    this.vm.executePendingJobs();
    return reply;
  }

  eval(code: string, file = 'eval.js'): any {
    const value = this.vm.evalCode(code, file).consume((h: any) => this.vm.dump(h));
    // Promise continuations the code started (a `fetch` that was refused outright) run before the next assertion.
    this.vm.executePendingJobs();
    return value;
  }

  render(): Node[] {
    const r = JSON.parse(this.eval('__card.render()'));
    assert.equal(r.ok, true, r.error);
    return r.tree;
  }

  renderRaw(): { ok: boolean; tree?: Node[]; error?: string } {
    return JSON.parse(this.eval('__card.render()'));
  }

  click(token: string, ev: object = { user: { id: 'u1' }, time: 1 }): boolean {
    const r = JSON.parse(this.eval(`__card.click(${JSON.stringify(token)}, ${JSON.stringify(JSON.stringify(ev))})`));
    this.vm.executePendingJobs();
    return r.found;
  }

  take(op?: string): Call[] {
    const out = op ? this.calls.filter((c) => c.op === op) : this.calls;
    this.calls = op ? this.calls.filter((c) => c.op !== op) : [];
    return out;
  }
}

/** Depth-first list of all nodes. */
function flat(tree: Node[]): Node[] {
  return tree.flatMap((n) => [n, ...flat(n.c)]);
}
function text(tree: Node[]): string {
  return flat(tree).filter((n) => n.t === 'text').map((n) => n.a.content).join('');
}
function buttons(tree: Node[]): Node[] {
  return flat(tree).filter((n) => n.t === 'button');
}

const COUNTER = `
  function Counter() {
    const [n, setN] = useState(0);
    return __jsx__('card', {}, [
      __jsx__('markdown', {}, ['Count: ', n]),
      __jsx__('button', { onClick: () => { setN(n + 1); setN(v => v + 1); } }, ['+2']),
      __jsx__('button', { type: 'danger', onClick: () => setN(0) }, ['reset']),
      __jsx__('button', {}, ['inert']),
    ]);
  }
  globalThis.Card = Counter;
`;

test('counter: click updates state, schedules once, tokens stay stable', async () => {
  const h = await Harness.create(COUNTER);
  let tree = h.render();
  assert.equal(text(tree), 'Count: 0+2resetinert');
  const [inc, reset, inert] = buttons(tree);
  assert.match(String(inc.a.id), /^[0-9a-z]{10}$/);
  assert.equal(inc.a.type, 'action');
  assert.equal(reset.a.type, 'danger');
  // A button without a handler is a label: an action button whose click finds no handler.
  assert.deepEqual(inert.a, { type: 'action', id: 'inert' });
  h.take();

  assert.equal(h.click(String(inc.a.id)), true);
  assert.equal(h.take('schedule').length, 1);
  tree = h.render();
  assert.equal(text(tree), 'Count: 2+2resetinert');
  assert.equal(buttons(tree)[0].a.id, inc.a.id);
  assert.equal(buttons(tree)[1].a.id, reset.a.id);

  // a second click after render schedules again (new dirty cycle)
  h.click(String(inc.a.id));
  assert.equal(h.take('schedule').length, 1);
  assert.equal(text(h.render()), 'Count: 4+2resetinert');
  assert.equal(h.click('nope'), false);
  h.vm.dispose();
});

test('keyed list keeps tokens per key across reorder/removal', async () => {
  const h = await Harness.create(`
    globalThis.Card = function List() {
      const [items, setItems] = useState(['a', 'b', 'c']);
      globalThis.setItems = setItems;
      return __jsx__('card', {}, [items.map((it) =>
        __jsx__('button', { key: it, onClick: () => setItems(items.filter((x) => x !== it)) }, [it]))]);
    };
  `);
  const ids = (t: Node[]) => Object.fromEntries(buttons(t).map((b) => [text(b.c), b.a.id]));
  const first = ids(h.render());
  assert.equal(new Set(Object.values(first)).size, 3);
  h.eval(`setItems(['c', 'a', 'b'])`);
  assert.deepEqual(ids(h.render()), first);
  assert.equal(h.click(String(first.b)), true);
  const after = ids(h.render());
  assert.deepEqual(after, { c: first.c, a: first.a });
  assert.equal(h.click(String(first.b)), false); // vanished position drops its token
  h.vm.dispose();
});

test('unmounted component runs effect cleanup and loses state', async () => {
  const h = await Harness.create(`
    function Child() {
      const [v] = useState(() => { globalThis.inits = (globalThis.inits || 0) + 1; return 1; });
      useEffect(() => { console.log('mount'); return () => console.log('cleanup'); }, []);
      return __jsx__('text', {}, ['child ', v]);
    }
    globalThis.Card = function Parent() {
      const [show, setShow] = useState(true);
      globalThis.setShow = setShow;
      return __jsx__('card', {}, [show ? __jsx__(Child, {}, []) : null]);
    };
  `);
  const logs = () => h.take('log').map((c) => JSON.parse(c.payload).text);
  assert.equal(text(h.render()), 'child 1');
  assert.deepEqual(logs(), ['mount']);
  h.render();
  assert.deepEqual(logs(), []);
  h.eval('setShow(false)');
  assert.equal(text(h.render()), '');
  assert.deepEqual(logs(), ['cleanup']);
  h.eval('setShow(true)');
  h.render();
  assert.deepEqual(logs(), ['mount']);
  assert.equal(h.eval('inits'), 2);
  h.eval('__card.unmount()');
  assert.deepEqual(logs(), ['cleanup']);
  h.vm.dispose();
});

test('useEffect deps semantics and cleanup ordering', async () => {
  const h = await Harness.create(`
    globalThis.log = [];
    globalThis.Card = function E() {
      const [a, setA] = useState(0);
      const [b, setB] = useState(0);
      globalThis.setA = setA; globalThis.setB = setB;
      useEffect(() => { log.push('every'); });
      useEffect(() => { log.push('once'); }, []);
      useLayoutEffect(() => { log.push('a=' + a); return () => log.push('~a=' + a); }, [a]);
      useEffect(() => { throw new Error('boom'); }, []);
      const memo = useMemo(() => { log.push('memo'); return a * 2; }, [a]);
      const cb = useCallback(() => a, [a]);
      if (globalThis.lastCb) log.push(globalThis.lastCb === cb ? 'cb same' : 'cb new');
      globalThis.lastCb = cb;
      const ref = useRef(0); ref.current++;
      const id = useId();
      return __jsx__('text', {}, [memo, ' ', ref.current, ' ', id]);
    };
  `);
  const take = () => h.eval('log.splice(0)');
  assert.equal(text(h.render()), '0 1 c1');
  assert.deepEqual(take(), ['memo', 'every', 'once', 'a=0']);
  assert.equal(h.take('error').length, 1);
  h.eval('setB(1)');
  assert.equal(text(h.render()), '0 2 c1');
  assert.deepEqual(take(), ['cb same', 'every']);
  h.eval('setA(5)');
  assert.equal(text(h.render()), '10 3 c1');
  assert.deepEqual(take(), ['memo', 'cb new', '~a=0', 'every', 'a=5']);
  h.eval('setA(5)'); // Object.is equal: no schedule
  h.take('schedule');
  h.eval('setA(5)');
  assert.equal(h.take('schedule').length, 0);
  assert.equal(h.take('error').length, 0);
  h.vm.dispose();
});

test('timers: setTimeout/setInterval, fireTimers and timers reports', async () => {
  const h = await Harness.create(`
    globalThis.fired = [];
    globalThis.Card = function T() { return 'x'; };
  `);
  const now = h.eval('Date.now()') as number;
  h.take();
  const t1 = h.eval(`setTimeout((x) => fired.push('t' + x), 50, 7)`);
  const t2 = h.eval(`setInterval(() => fired.push('i'), 10)`); // clamped to 100
  const t3 = h.eval(`setTimeout(() => fired.push('never'), 1000)`);
  assert.ok(t1 < t2 && t2 < t3);
  const reports = h.take('timers').map((c) => Number(c.payload));
  assert.equal(reports.length, 3);
  assert.ok(reports[0] >= now + 50 && reports[0] < now + 1000);
  h.eval(`clearTimeout(${t3})`);
  assert.equal(h.take('timers').length, 1);

  const next = h.eval('__card.nextTimer()') as number;
  assert.equal(next, reports[0]);
  h.eval(`__card.fireTimers(${next})`);
  assert.deepEqual(h.eval('fired.splice(0)'), ['t7']);
  const r = h.take('timers');
  assert.equal(r.length, 1);
  const intervalDue = Number(r[0].payload);
  assert.ok(intervalDue >= now + 100);

  // far in the future: interval fires once and is re-armed after now (no catch-up storm)
  const late = intervalDue + 10_000;
  h.eval(`__card.fireTimers(${late})`);
  assert.deepEqual(h.eval('fired.splice(0)'), ['i']);
  assert.equal(Number(h.take('timers')[0].payload), late + 1);

  h.eval(`clearInterval(${t2})`);
  assert.equal(h.take('timers')[0].payload, '-1');
  assert.equal(h.eval('__card.nextTimer()'), -1);

  // timer callback errors are reported
  h.eval(`setTimeout(() => { throw new Error('tick fail'); }, 0)`);
  h.eval(`__card.fireTimers(Date.now() + 1)`);
  assert.match(h.take('error')[0].payload, /tick fail/);
  assert.equal(h.eval('typeof queueMicrotask'), 'function');
  h.vm.dispose();
});

test('click: async rejection and sync throw are reported via error', async () => {
  const h = await Harness.create(`
    globalThis.Card = function A() {
      return __jsx__(__fragment__, {}, [
        __jsx__('button', { onClick: async (ev) => { await null; throw new Error('async nope ' + ev.user.id); } }, ['a']),
        __jsx__('button', { onClick: () => { throw new Error('sync nope'); } }, ['b']),
        __jsx__('button', { onClick: (ev) => { globalThis.lastEvent = ev; } }, ['c']),
      ]);
    };
  `);
  const [a, b, c] = buttons(h.render());
  h.take();
  assert.equal(h.click(String(a.a.id)), true);
  const e1 = h.take('error');
  assert.equal(e1.length, 1);
  assert.match(e1[0].payload, /async nope u1/);
  assert.equal(h.click(String(b.a.id)), true);
  assert.match(h.take('error')[0].payload, /sync nope/);
  h.click(String(c.a.id), { user: { id: 'u2', name: 'Ann' }, data: { k: 1 }, time: 5 });
  assert.deepEqual(h.eval('lastEvent'), { user: { id: 'u2', name: 'Ann' }, data: { k: 1 }, time: 5 });
  h.vm.dispose();
});

test('render error returns ok:false and keeps previous state', async () => {
  const h = await Harness.create(`
    globalThis.Card = function R() {
      const [n, setN] = useState(0);
      globalThis.setN = setN;
      if (globalThis.fail) throw new Error('render broke');
      return __jsx__('text', {}, ['n=', n]);
    };
  `);
  h.render();
  h.eval('setN(3); globalThis.fail = true');
  const r = h.renderRaw();
  assert.equal(r.ok, false);
  assert.match(String(r.error), /^render broke\n/);
  h.eval('globalThis.fail = false');
  assert.equal(text(h.render()), 'n=3');
  h.vm.dispose();
});

test('fragments, nested components, arrays, numbers, booleans, children prop', async () => {
  const h = await Harness.create(`
    function Item({ label, children }) { return __jsx__('li', { label }, [children]); }
    function Wrap(props) { return props.children; }
    globalThis.Card = function F() {
      return __jsx__(Wrap, {}, [
        __jsx__(__fragment__, {}, [
          'a', 1, 0, true, false, null, undefined, [[2, ['b']]],
          __jsx__(Item, { label: 'x' }, ['one']),
          __jsx__(Item, { label: 'y', key: 'k' }, []),
        ]),
      ]);
    };
  `);
  const tree = h.render();
  assert.deepEqual(tree, [
    { t: 'text', a: { content: 'a' }, c: [] },
    { t: 'text', a: { content: '1' }, c: [] },
    { t: 'text', a: { content: '0' }, c: [] },
    { t: 'text', a: { content: '2' }, c: [] },
    { t: 'text', a: { content: 'b' }, c: [] },
    { t: 'li', a: { label: 'x' }, c: [{ t: 'text', a: { content: 'one' }, c: [] }] },
    { t: 'li', a: { label: 'y' }, c: [] },
  ]);
  // the default export may be an element instead of a component
  h.eval(`__card.mount(__jsx__('text', { size: 2 }, ['el']), '{"ignored":1}')`);
  assert.deepEqual(h.render(), [{ t: 'text', a: { size: 2 }, c: [{ t: 'text', a: { content: 'el' }, c: [] }] }]);
  // props from mount
  h.eval(`__card.mount(function P(p) { return p.who; }, '{"who":"bob"}')`);
  assert.equal(text(h.render()), 'bob');
  h.vm.dispose();
});

test('attrs filtering: functions/undefined dropped, JSON-safe values kept', async () => {
  const h = await Harness.create(`
    globalThis.Card = function A() {
      return __jsx__('button', {
        onClick: () => {}, onHover: () => {}, label: 'L', n: 3, b: false, u: undefined, nul: null,
        confirm: { title: 'T', text: 'sure?', extra: undefined, f() {} }, list: [1, 'two', null, { x: 1 }],
        id: 'ignored-by-token',
      }, []);
    };
  `);
  const [btn] = h.render();
  const { id, ...rest } = btn.a;
  assert.match(String(id), /^[0-9a-z]{10}$/);
  assert.deepEqual(rest, {
    label: 'L', n: 3, b: false, confirm: { title: 'T', text: 'sure?' }, list: [1, 'two', { x: 1 }], type: 'action',
  });
  h.vm.dispose();
});

test('useCard toast/close/send and agent.send ops', async () => {
  const h = await Harness.create(`
    globalThis.Card = function C() {
      const card = useCard();
      globalThis.card = card;
      return 'c';
    };
  `);
  h.render();
  h.take();
  h.eval(`card.toast('hi'); card.toast('ok', 'success'); card.toast('x', 'bogus')`);
  assert.deepEqual(h.take('toast').map((c) => JSON.parse(c.payload)), [
    { content: 'hi', type: 'info' }, { content: 'ok', type: 'success' }, { content: 'x', type: 'info' },
  ]);
  h.eval('card.close()');
  assert.deepEqual(h.take('close'), [{ op: 'close', payload: '' }]);
  assert.deepEqual(h.eval(`card.send('do it')`), { ok: true });
  h.agentReply = '{"ok":false,"error":"busy"}';
  assert.deepEqual(h.eval(`agent.send('again')`), { ok: false, error: 'busy' });
  assert.deepEqual(h.take('agent').map((c) => c.payload), ['do it', 'again']);
  assert.deepEqual(h.eval('Object.keys(__cardApi)'), [
    'useState', 'useReducer', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef', 'useId', 'useCard',
    'useStoredState', 'Fragment', 'agent', 'fs', 'fetch',
    'PromptButton', 'PromptChoices', 'PromptForm', 'Switch', 'Segmented', 'Stepper', 'AuthRequest',
  ]);
  h.eval(`console.warn('w', { a: 1 }, 2, [3]); console.info('i')`);
  assert.deepEqual(h.take('log').map((c) => JSON.parse(c.payload)), [
    { level: 'warn', text: 'w {"a":1} 2 [3]' }, { level: 'log', text: 'i' },
  ]);
  h.vm.dispose();
});

test('guards: nesting depth, node count, render-phase update loop', async () => {
  const h = await Harness.create(`
    function Deep({ n }) { return n === 0 ? 'end' : __jsx__(Deep, { n: n - 1 }, []); }
    globalThis.Card = function G() { return __jsx__(Deep, { n: globalThis.depth }, []); };
  `);
  h.eval('globalThis.depth = 60');
  assert.equal(text(h.render()), 'end');
  h.eval('globalThis.depth = 70');
  assert.match(String(h.renderRaw().error), /component nesting too deep/);

  h.eval(`__card.mount(() => Array.from({ length: 2001 }, (_, i) => i), '{}')`);
  assert.match(String(h.renderRaw().error), /2000 nodes/);

  h.eval(`__card.mount(function Loop() { const [n, setN] = useState(0); setN(n + 1); return n; }, '{}')`);
  assert.match(String(h.renderRaw().error), /too many re-renders/);

  h.eval(`__card.mount(function Once() { const [n, setN] = useState(0); if (n < 3) setN(n + 1); return n; }, '{}')`);
  h.take();
  assert.equal(text(h.render()), '3');
  assert.equal(h.take('schedule').length, 0);
  h.vm.dispose();
});

test('snapshot round trip: state and tokens survive restore', async () => {
  const h = await Harness.create(COUNTER);
  let tree = h.render();
  const incId = String(buttons(tree)[0].a.id);
  h.click(incId);
  tree = h.render();
  assert.equal(text(tree), 'Count: 2+2resetinert');
  h.eval(`setTimeout(() => console.log('timer after restore'), 0)`);

  h.vm.runGC();
  const bytes: Uint8Array = QuickJS.serializeSnapshot(h.vm.snapshot());
  h.vm.dispose();
  const zst = zstdCompressSync(bytes, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } });
  console.log(`snapshot: raw ${bytes.length} bytes, zstd(3) ${zst.length} bytes`);

  const h2 = new Harness();
  h2.vm = await QuickJS.restore(QuickJS.deserializeSnapshot(bytes), { wasm });
  h2.vm.registerHostCallback('__host', h2.hostFn());
  assert.equal(h2.click(incId), true);
  assert.equal(h2.take('schedule').length, 1);
  tree = h2.render();
  assert.equal(text(tree), 'Count: 4+2resetinert');
  assert.equal(buttons(tree)[0].a.id, incId);
  h2.eval('__card.fireTimers(Date.now() + 1)');
  assert.equal(JSON.parse(h2.take('log')[0].payload).text, 'timer after restore');
  h2.vm.dispose();
});

const CHOOSER = `
  function Chooser() {
    const [picked, setPicked] = useState('-');
    const [sent, setSent] = useState('-');
    return __jsx__('card', {}, [
      __jsx__('markdown', {}, ['picked ', picked, ' sent ', sent]),
      __jsx__('select', { id: 'author-id', name: 'size', onSelect: (e) => setPicked(e.values.join('+')) }, [
        __jsx__('option', { value: 's' }, ['Small']),
        __jsx__('option', { value: 'l' }, ['Large']),
      ]),
      __jsx__('select', { id: 'plain', name: 'plain' }, [__jsx__('option', { value: 'a' }, ['A'])]),
      __jsx__('form', { name: 'order' }, [
        __jsx__('input', { name: 'title', label: 'Title' }),
        __jsx__('button', { type: 'submit', onClick: (e) => setSent(String(e.values.title)) }, ['Send']),
      ]),
    ]);
  }
  globalThis.Card = Chooser;
`;

test('select: onSelect gets a token, a pick reaches the handler, an unhandled select keeps its id', async () => {
  const h = await Harness.create(CHOOSER);
  let tree = h.render();
  const selects = flat(tree).filter((n) => n.t === 'select');
  const [live, plain] = selects;
  // The handled select is routed by token; `name` still keys its value in the enclosing form.
  assert.match(String(live.a.id), /^[0-9a-z]{10}$/);
  assert.equal(live.a.name, 'size');
  // A select without a handler is a plain form field: it keeps the id the author wrote.
  assert.equal(plain.a.id, 'plain');
  assert.equal(h.click('plain'), false);

  assert.equal(h.click(String(live.a.id), { user: { id: 'u2' }, values: ['l'], time: 7 }), true);
  tree = h.render();
  assert.equal(text(tree), 'picked l sent -SmallLargeASend');
  // The token survives the re-render of the same position.
  assert.equal(flat(tree).filter((n) => n.t === 'select')[0].a.id, live.a.id);

  const submit = flat(tree).filter((n) => n.t === 'button')[0];
  assert.equal(submit.a.type, 'submit');
  assert.match(String(submit.a.id), /^[0-9a-z]{10}$/);
  assert.equal(h.click(String(submit.a.id), { user: { id: 'u2' }, values: { title: 'Weekly' }, time: 8 }), true);
  tree = h.render();
  assert.equal(text(tree), 'picked l sent WeeklySmallLargeASend');
});

const STORE = `
  function Store() {
    const [votes, setVotes] = useStoredState('poll.json', { a: 0 });
    const [listing, setListing] = useState('-');
    return __jsx__('card', {}, [
      __jsx__('markdown', {}, ['a=', votes.a, ' listing=', listing, ' stored=', String(fs.exists('poll.json'))]),
      __jsx__('button', { onClick: () => setVotes((v) => ({ a: v.a + 1 })) }, ['vote']),
      __jsx__('button', { onClick: () => {
        fs.writeFile('notes/day.txt', 'hello');
        fs.appendFile('notes/day.txt', ' world');
        setListing(fs.listFiles('notes').map((f) => f.name + ':' + f.size).join(','));
      } }, ['write']),
      __jsx__('button', { onClick: () => {
        try { fs.readFile('../secret.txt'); } catch (e) { console.log('refused ' + e.message); }
        fs.removeFile('notes/day.txt');
        setListing(String(fs.exists('notes/day.txt')));
      } }, ['wipe']),
    ]);
  }
  globalThis.Card = Store;
`;

test('fs: a card reads and writes its data folder, and useStoredState keeps a value there', async () => {
  const h = await Harness.create(STORE);
  const line = () => text(h.render()).replace(/(votewritewipe)+$/, '');
  assert.equal(line(), 'a=0 listing=- stored=false');
  const [vote] = buttons(h.render());

  assert.equal(h.click(String(vote.a.id)), true);
  assert.deepEqual(JSON.parse(h.files.get('poll.json')!), { a: 1 });
  assert.equal(line(), 'a=1 listing=- stored=true');

  // The file is the store: a fresh mount of the same card starts from it, not from `initial`.
  h.eval(`__card.mount(globalThis.Card, '{}')`);
  assert.equal(line(), 'a=1 listing=- stored=true');

  const [write, wipe] = buttons(h.render()).slice(1);
  assert.equal(h.click(String(write.a.id)), true);
  assert.equal(h.files.get('notes/day.txt'), 'hello world');
  assert.match(line(), /listing=day\.txt:11/);

  assert.equal(h.click(String(wipe.a.id)), true);
  assert.equal(h.files.has('notes/day.txt'), false);
  assert.match(line(), /listing=false/);
  assert.match(JSON.parse(h.take('log')[0]!.payload).text, /path escapes the card folder: \.\.\/secret\.txt/);
  h.vm.dispose();
});

const REQUESTER = `
  function Requester() {
    const [line, setLine] = useState('waiting');
    globalThis.ask = (init) => {
      fetch('https://api.test/thing', init)
        .then((r) => r.json().then((body) => setLine(r.status + ' ' + r.headers.get('X-Test') + ' ' + body.v)))
        .catch((e) => setLine('error ' + e.message));
    };
    return __jsx__('markdown', {}, [line]);
  }
  globalThis.Card = Requester;
`;

test('fetch: the request reaches the host, and its settlement resolves the promise', async () => {
  const h = await Harness.create(REQUESTER);
  assert.equal(text(h.render()), 'waiting');

  h.eval(`ask({ method: 'POST', headers: { 'x-a': '1' }, body: 'hi' })`);
  assert.deepEqual(h.requests, [{ url: 'https://api.test/thing', method: 'POST', headers: { 'x-a': '1' }, body: 'hi' }]);
  h.take();
  assert.deepEqual(h.settle('r1', {
    ok: true, url: 'https://api.test/thing', status: 200, statusText: 'OK',
    headers: { 'content-type': 'application/json', 'x-test': 'yes' }, body: '{"v":"seven"}',
  }), { found: true });
  assert.equal(h.take('schedule').length, 1);
  assert.equal(text(h.render()), '200 yes seven');

  // A failed request rejects the promise, and the card sees the reason.
  h.eval('ask({})');
  h.settle('r2', { ok: false, error: 'connection refused' });
  assert.equal(text(h.render()), 'error connection refused');

  // A request the host refuses outright never leaves the process.
  h.fetchReply = '{"ok":false,"error":"api.test is not a host a card may reach"}';
  h.eval('ask({})');
  assert.equal(text(h.render()), 'error api.test is not a host a card may reach');
  assert.equal(h.requests.length, 2);

  // An answer nobody waits for any more is ignored rather than crashing the host call.
  assert.deepEqual(h.settle('r99', { ok: true, status: 200, statusText: 'OK', url: '', headers: {}, body: '' }),
    { found: false });
  h.vm.dispose();
});

test('AuthRequest preset invokes host actions and receives pushEvent updates', async () => {
  const h = await Harness.create(`
    globalThis.Card = function Auth() {
      return __jsx__(AuthRequest, { capabilities: ['feishu-project'], reason: '需要读取需求' }, []);
    };
  `);
  const actionCalls: { name: string; payload: unknown }[] = [];
  h.actionHandler = (name, payload) => {
    actionCalls.push({ name, payload });
    if (name === 'auth:describe') {
      return { ok: true, capabilities: [{ id: 'feishu-project', title: '飞书项目', description: '读写工作项' }] };
    }
    if (name === 'auth:grant') {
      return {
        ok: true,
        toast: '已发送私聊登录卡',
        state: {
          status: 'pending',
          owner: { id: 'ou_1', name: '张三' },
          actor: { id: 'ou_1', name: '张三' },
          items: [{ id: 'feishu-project', title: '飞书项目', status: 'pending', message: '请在私聊完成登录' }],
        },
      };
    }
    if (name === 'auth:revoke') {
      return {
        ok: true,
        toast: '已撤销授权',
        state: {
          status: 'revoked',
          owner: { id: 'ou_1', name: '张三' },
          items: [{ id: 'feishu-project', title: '飞书项目', status: 'revoked' }],
        },
      };
    }
    return { ok: false, error: 'unexpected' };
  };

  let tree = h.render();
  assert.match(text(tree), /飞书项目/);
  assert.match(text(tree), /需要读取需求/);
  const grantBtn = buttons(tree)[0]!;
  assert.equal(h.click(String(grantBtn.a.id), { user: { id: 'ou_1', name: '张三' }, time: 1 }), true);
  assert.equal(actionCalls.some(c => c.name === 'auth:grant'), true);

  tree = h.render();
  assert.match(text(tree), /等待 张三 在私聊中完成登录/);
  h.take();

  // Simulate async DM OAuth completion pushed from host.
  const pushed = JSON.parse(h.eval(`__card.pushEvent('auth', ${JSON.stringify(JSON.stringify({
    status: 'granted',
    owner: { id: 'ou_1', name: '张三' },
    actor: { id: 'ou_1', name: '张三' },
    items: [{ id: 'feishu-project', title: '飞书项目', status: 'active' }],
  }))})`));
  assert.deepEqual(pushed, { handled: true });
  assert.equal(h.take('schedule').length, 1);

  tree = h.render();
  assert.match(text(tree), /已授权并独占会话/);
  const revokeBtn = buttons(tree).find(b => text([b]) === '撤销授权');
  assert.ok(revokeBtn, 'revoke button appears on granted card');
  assert.equal(h.click(String(revokeBtn.a.id), { user: { id: 'ou_1', name: '张三' }, time: 2 }), true);

  tree = h.render();
  assert.match(text(tree), /已撤销能力授权（会话仍保持独占）/);
  h.vm.dispose();
});

test('AuthRequest allows non-requester clickers by default, while explicit sender="requester" restricts clicks', async () => {
  const h = await Harness.create(`
    globalThis.__cardContext = { requester: { id: 'ou_init', name: '发起人' } };
    globalThis.Card = function Auth() {
      return __jsx__(AuthRequest, { capabilities: ['feishu-project'] }, []);
    };
  `);
  const grants: unknown[] = [];
  h.actionHandler = (name, payload) => {
    if (name === 'auth:describe') {
      return { ok: true, capabilities: [{ id: 'feishu-project', title: '飞书项目' }] };
    }
    if (name === 'auth:grant') {
      grants.push(payload);
      return {
        ok: true,
        toast: '授权成功',
        state: {
          status: 'granted',
          owner: { id: 'ou_other', name: '授权人B' },
          actor: { id: 'ou_other', name: '授权人B' },
          items: [{ id: 'feishu-project', title: '飞书项目', status: 'active' }],
        },
      };
    }
    return { ok: false, error: 'unexpected' };
  };

  const tree = h.render();
  const grantBtn = buttons(tree)[0]!;
  assert.equal(h.click(String(grantBtn.a.id), { user: { id: 'ou_other', name: '授权人B' }, time: 1 }), true);
  assert.equal(grants.length, 1, 'non-requester is allowed to authorize by default');
  h.vm.dispose();

  const restricted = await Harness.create(`
    globalThis.__cardContext = { requester: { id: 'ou_init', name: '发起人' } };
    globalThis.Card = function Auth() {
      return __jsx__(AuthRequest, { capabilities: ['feishu-project'], sender: 'requester' }, []);
    };
  `);
  let restrictedGrantCalls = 0;
  restricted.actionHandler = (name) => {
    if (name === 'auth:describe') return { ok: true, capabilities: [{ id: 'feishu-project', title: '飞书项目' }] };
    if (name === 'auth:grant') restrictedGrantCalls++;
    return { ok: true };
  };
  const rTree = restricted.render();
  const rBtn = buttons(rTree)[0]!;
  restricted.click(String(rBtn.a.id), { user: { id: 'ou_other', name: '授权人B' }, time: 2 });
  assert.equal(restrictedGrantCalls, 0, 'explicit sender="requester" still blocks non-requester');
  restricted.vm.dispose();
});
