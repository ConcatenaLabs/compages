// Address derivation for contract descriptors, with no compiler.
//
// A version 2 descriptor describes a taproot tree of Simplicity leaves (version
// 0xbe), tapscript leaves (0xc4) and hidden data leaves; an instance's output is
// its parameters and slots put in place in that tree, then one curve tweak. A
// version 1 descriptor is the tree
//
//     P2TR(internal_key, TapBranch(TapLeaf_0xbe(CMR), H_TapData(param_bytes)))
//
// and is read as that version 2 tree. This module needs only Node's built-in
// crypto. docs/descriptor.md is the specification.
import { createHash } from 'node:crypto';

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
const LEAF_VERSION_SIMPLICITY = 0xbe;
const LEAF_VERSION_TAPSCRIPT = 0xc4;
const WIDTHS = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32, Pubkey: 32 };
const ROLES = ['pubkey', 'asset', 'amount', 'script_hash', 'height', 'time', 'hash', 'feed', 'number', 'sequence'];
const NUMS_KEY = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
const MAX_TREE_DEPTH = 128;
const MAX_JSON_DEPTH = 300;
const SEQUENCE_BITS = (1 << 22) | 0xffff;
const V1_PROGRAM_LEAF = 'program';
const V1_DATA_LEAF = 'params';
const SEQUENTIA_BUDGET = { per_witness_byte: 4, offset: 50, max: 4000050 };

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b) => Buffer.from(b).toString('hex');

// Lowercase hex, of exactly `width` bytes when given. Buffer.from(s, 'hex')
// stops at the first character that is not hex and drops it silently, so it
// is not used to read input.
export function unhex(s, width) {
  if (typeof s !== 'string' || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) {
    throw new Error(`not lowercase hex: ${JSON.stringify(s)}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  if (width !== undefined && out.length !== width) {
    throw new Error(`${out.length} bytes where ${width} are needed`);
  }
  return out;
}

// The shape of each version: every field, its type, and which are optional
// (a '?' suffix). An object with any other field is refused. A version 2
// tree is checked by readNode, not by shape.
const STR = 'str';
const INT = 'int';
const PARAM = { name: STR, type: STR, role: STR, label: STR };
const WITNESS = { name: STR, type: STR, source: STR };
const COMPILER = { name: STR, version: STR };
const TEMPLATE_V1 = {
  name: STR, version: INT, summary: STR, layout: STR, internal_key: STR, 'key_path?': STR,
  program: { source: STR, source_sha256: STR, cmr: STR, compiler: COMPILER, witness: [WITNESS] },
  params: [PARAM],
  paths: [{ name: STR, who: STR, effect: STR }],
};
const TEMPLATE_V2 = {
  name: STR, version: INT, summary: STR, internal_key: STR, 'key_path?': STR,
  params: [PARAM], slots: [PARAM],
  budget: { per_witness_byte: INT, offset: INT, max: INT },
  tree: 'tree',
  paths: [{ name: STR, who: STR, effect: STR, 'leaf?': STR }],
};
const SIMPLICITY_LEAF = {
  source: STR, source_sha256: STR, cmr: STR, compiler: COMPILER, witness: [WITNESS], max_cost_wu: INT,
};
const descriptorShape = (template) => ({
  descriptor: INT, template, template_hash: STR,
  chains: [{ name: STR, genesis: 'str|null', bech32_hrp: STR }],
  'measured?': 'any',
});

const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkShape(value, shape, at) {
  if (shape === 'any' || shape === 'tree') return;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) throw new Error(`${at} is not an array`);
    value.forEach((item, i) => checkShape(item, shape[0], `${at}[${i}]`));
  } else if (typeof shape === 'object') {
    if (!isObject(value)) throw new Error(`${at} is not an object`);
    const fields = new Map(Object.keys(shape).map((k) => [k.replace(/\?$/, ''), k]));
    for (const k of Object.keys(value)) {
      if (!fields.has(k)) throw new Error(`${at}: unknown field ${k}`);
    }
    for (const [k, key] of fields) {
      if (own(value, k)) checkShape(value[k], shape[key], `${at}.${k}`);
      else if (!key.endsWith('?')) throw new Error(`${at}: missing field ${k}`);
    }
  } else if (shape === INT) {
    if (!isInt(value)) throw new Error(`${at}: ${value} is not an integer in [0, 2^53)`);
  } else if (shape === STR) {
    if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  } else if (shape === 'str|null') {
    if (value !== null && typeof value !== 'string') throw new Error(`${at} is not a string or null`);
  }
}

function checkNumbers(value, at) {
  if (typeof value === 'number') {
    if (!isInt(value)) throw new Error(`${at}: ${value} is not an integer in [0, 2^53)`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkNumbers(v, `${at}[${i}]`));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) checkNumbers(v, `${at}.${k}`);
  }
}

const printable = (s) => /^[\x20-\x7e]*$/.test(s);

function checkAscii(value, at) {
  if (typeof value === 'string') {
    if (!printable(value)) throw new Error(`${at}: a template is printable ASCII`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkAscii(v, `${at}[${i}]`));
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (!printable(k)) throw new Error(`${at}: a template is printable ASCII`);
      checkAscii(v, `${at}.${k}`);
    }
  }
}

function readNode(v, depth, at) {
  if (depth > MAX_TREE_DEPTH) throw new Error(`${at}: the tree is deeper than ${MAX_TREE_DEPTH}`);
  if (!isObject(v)) throw new Error(`${at} is not an object`);
  if (own(v, 'branch')) {
    for (const k of Object.keys(v)) if (k !== 'branch') throw new Error(`${at}: unknown field ${k}`);
    const kids = v.branch;
    if (!Array.isArray(kids) || kids.length !== 2) throw new Error(`${at}.branch is not an array of two nodes`);
    return { kind: 'branch', a: readNode(kids[0], depth + 1, `${at}.branch[0]`), b: readNode(kids[1], depth + 1, `${at}.branch[1]`) };
  }
  const kinds = ['simplicity', 'tapscript', 'data'];
  for (const k of Object.keys(v)) {
    if (k !== 'leaf' && !kinds.includes(k)) throw new Error(`${at}: unknown field ${k}`);
  }
  if (!own(v, 'leaf')) throw new Error(`${at}: missing field leaf`);
  if (typeof v.leaf !== 'string') throw new Error(`${at}.leaf is not a string`);
  const present = kinds.filter((k) => own(v, k));
  if (present.length !== 1) throw new Error(`${at}: a leaf has exactly one of simplicity, tapscript and data`);
  const [kind] = present;
  const body = v[kind];
  if (kind === 'simplicity') {
    checkShape(body, SIMPLICITY_LEAF, `${at}.simplicity`);
    return { kind, name: v.leaf, body };
  }
  if (kind === 'tapscript') {
    if (!Array.isArray(body)) throw new Error(`${at}.tapscript is not an array`);
    const items = body.map((item, i) => {
      const iat = `${at}.tapscript[${i}]`;
      if (typeof item === 'string') {
        const b = unhex(item);
        if (b.length === 0) throw new Error(`${iat}: empty`);
        return { k: 'bytes', v: b };
      }
      if (isObject(item) && Object.keys(item).length === 1) {
        const [k] = Object.keys(item);
        if (k !== 'push' && k !== 'num') throw new Error(`${iat}: unknown field ${k}`);
        if (typeof item[k] !== 'string') throw new Error(`${iat}.${k} is not a string`);
        return { k, v: item[k] };
      }
      throw new Error(`${iat}: an item is hex, {"push": P} or {"num": P}`);
    });
    return { kind, name: v.leaf, body: items };
  }
  if (!Array.isArray(body) || !body.every((x) => typeof x === 'string')) {
    throw new Error(`${at}.data is not an array of names`);
  }
  return { kind, name: v.leaf, body: [...body] };
}

function leavesOf(node, depth = 0) {
  if (node.kind === 'branch') return [...leavesOf(node.a, depth + 1), ...leavesOf(node.b, depth + 1)];
  return [[node, depth]];
}

// The tree a descriptor of either version describes. A version 1 template is
// branch(program, params): its program the leaf "program", its parameters in
// order the data leaf "params", and every path but the key path a spend of
// the program.
export function model(d) {
  const t = d.template;
  const keyPath = own(t, 'key_path') ? t.key_path : null;
  if (d.descriptor === 1) {
    return {
      internal_key: t.internal_key, key_path: keyPath, params: t.params, slots: [],
      budget: { ...SEQUENTIA_BUDGET },
      tree: {
        kind: 'branch',
        a: { kind: 'simplicity', name: V1_PROGRAM_LEAF, body: { ...t.program, max_cost_wu: 0 } },
        b: { kind: 'data', name: V1_DATA_LEAF, body: t.params.map((p) => p.name) },
      },
      paths: t.paths.map((p) => (p.name === keyPath ? { ...p } : { ...p, leaf: V1_PROGRAM_LEAF })),
    };
  }
  return {
    internal_key: t.internal_key, key_path: keyPath, params: t.params, slots: t.slots, budget: t.budget,
    tree: readNode(t.tree, 0, 'template.tree'), paths: t.paths,
  };
}

function field(m, name) {
  const p = m.params.find((x) => x.name === name);
  if (p) return [p, false];
  const s = m.slots.find((x) => x.name === name);
  if (s) return [s, true];
  return [null, null];
}

const badName = (s) => s.length === 0 || !printable(s);
// A file in the descriptor's own directory: letters, digits, _ and -, then .simf.
const sourceNameOk = (s) => /^[A-Za-z0-9_-]+\.simf$/.test(s);

function checkWitness(m, leaf, w) {
  const src = w.source;
  if (src === 'spender') return;
  for (const [prefix, group, kind] of [['param:', m.params, 'parameter'], ['slot:', m.slots, 'slot']]) {
    if (src.startsWith(prefix)) {
      const name = src.slice(prefix.length);
      const p = group.find((x) => x.name === name);
      if (!p) throw new Error(`leaf ${leaf}: witness ${w.name}: ${name} is no ${kind}`);
      if (p.type !== w.type) throw new Error(`leaf ${leaf}: witness ${w.name}: type ${w.type} is not the ${kind}'s ${p.type}`);
      return;
    }
  }
  if (src.startsWith('signature:sig_all_hash:')) {
    const name = src.slice('signature:sig_all_hash:'.length);
    const p = m.params.find((x) => x.name === name);
    if (!p) throw new Error(`leaf ${leaf}: witness ${w.name}: ${name} is no parameter`);
    if (p.type !== 'Pubkey' || w.type !== 'Signature') {
      throw new Error(`leaf ${leaf}: witness ${w.name}: a signature is of type Signature, by a Pubkey parameter`);
    }
    return;
  }
  throw new Error(`leaf ${leaf}: witness ${w.name}: source ${src} is not one the specification lists`);
}

// Every rule a reader checks without a compiler.
export function checkModel(m) {
  const internal = unhex(m.internal_key, 32);
  liftX(big(internal));
  const nums = m.internal_key === NUMS_KEY;
  if (nums && m.key_path !== null) throw new Error('key_path is declared, but the internal key is the NUMS key');
  if (!nums) {
    if (m.key_path === null) throw new Error('the internal key is not the NUMS key and the template declares no key path');
    if (!m.paths.some((p) => p.name === m.key_path)) throw new Error(`key_path ${m.key_path} is not one of the template's paths`);
  }
  const names = new Set();
  for (const [kind, group] of [['parameter', m.params], ['slot', m.slots]]) {
    for (const p of group) {
      if (badName(p.name)) throw new Error(`${kind} name ${JSON.stringify(p.name)} is empty or not printable`);
      if (names.has(p.name)) throw new Error(`${kind} ${p.name} is named twice`);
      names.add(p.name);
      if (!own(WIDTHS, p.type)) throw new Error(`${kind} ${p.name}: type ${p.type} is not allowed`);
      if (!ROLES.includes(p.role)) throw new Error(`${kind} ${p.name}: role ${p.role} is not allowed`);
      if (p.role === 'pubkey' && p.type !== 'Pubkey') throw new Error(`${kind} ${p.name}: a pubkey is of type Pubkey`);
      if (p.role === 'sequence' && p.type !== 'u32') throw new Error(`${kind} ${p.name}: a sequence is of type u32`);
    }
  }
  const leafNames = new Set();
  const used = new Set();
  const spendable = new Set();
  for (const [{ kind, name, body }, depth] of leavesOf(m.tree)) {
    if (depth > MAX_TREE_DEPTH) throw new Error(`leaf ${name} is deeper than ${MAX_TREE_DEPTH}`);
    if (badName(name)) throw new Error(`leaf name ${JSON.stringify(name)} is empty or not printable`);
    if (leafNames.has(name)) throw new Error(`leaf ${name} is named twice`);
    leafNames.add(name);
    if (kind === 'data') {
      if (body.length === 0) throw new Error(`data leaf ${name} commits to nothing`);
      for (const v of body) {
        if (field(m, v)[0] === null) throw new Error(`data leaf ${name}: ${v} is no parameter or slot`);
        used.add(v);
      }
    } else if (kind === 'tapscript') {
      spendable.add(name);
      if (body.length === 0) throw new Error(`tapscript leaf ${name} is empty`);
      for (const { k, v } of body) {
        if (k === 'bytes') continue;
        const [param, isSlot] = field(m, v);
        if (param === null) throw new Error(`tapscript leaf ${name}: ${v} is no parameter`);
        if (isSlot) throw new Error(`tapscript leaf ${name}: ${v} is a slot; a script holds parameters only`);
        if (k === 'push' && WIDTHS[param.type] < 2) throw new Error(`tapscript leaf ${name}: push ${v} is one byte; use num`);
        if (k === 'num' && WIDTHS[param.type] > 8) throw new Error(`tapscript leaf ${name}: num ${v} is wider than 8 bytes`);
        used.add(v);
      }
    } else {
      spendable.add(name);
      const wnames = new Set();
      for (const w of body.witness) {
        if (badName(w.name) || wnames.has(w.name)) {
          throw new Error(`leaf ${name}: witness ${JSON.stringify(w.name)} is empty, not printable or named twice`);
        }
        wnames.add(w.name);
        checkWitness(m, name, w);
      }
      if (!sourceNameOk(body.source)) {
        throw new Error(`leaf ${name}: source ${JSON.stringify(body.source)} is not a file name of the form <name>.simf beside the descriptor`);
      }
      unhex(body.cmr, 32);
      unhex(body.source_sha256, 32);
    }
  }
  for (const p of [...m.params, ...m.slots]) {
    if (!used.has(p.name)) throw new Error(`${p.name} is in no leaf, so it does not change the output`);
  }
  if (m.paths.length === 0) throw new Error('the template has no path');
  const pnames = new Set();
  const covered = new Set();
  for (const p of m.paths) {
    if (badName(p.name) || pnames.has(p.name)) throw new Error(`path name ${JSON.stringify(p.name)} is empty, not printable or used twice`);
    pnames.add(p.name);
    const isKey = m.key_path === p.name;
    const hasLeaf = own(p, 'leaf');
    if (hasLeaf && isKey) throw new Error(`path ${p.name}: the key path spends no leaf`);
    if (!hasLeaf && !isKey) throw new Error(`path ${p.name} names no leaf`);
    if (hasLeaf) {
      if (!spendable.has(p.leaf)) throw new Error(`path ${p.name}: ${p.leaf} is not a Simplicity or tapscript leaf`);
      covered.add(p.leaf);
    }
  }
  for (const l of [...spendable].sort()) {
    if (!covered.has(l)) throw new Error(`leaf ${l} is spendable and no path describes it`);
  }
}

// Refuse a descriptor whose shape is not its version's, that holds a number
// other than an integer in [0, 2^53), text that is not printable ASCII in its
// template, a template hash that does not match, or a tree, parameter, slot or
// path that breaks a rule of the specification.
export function checkDescriptor(d) {
  checkNumbers(d, 'descriptor');
  const version = isObject(d) ? d.descriptor : undefined;
  if (version !== 1 && version !== 2) throw new Error(`descriptor version ${version} is not 1 or 2`);
  checkShape(d, descriptorShape(version === 1 ? TEMPLATE_V1 : TEMPLATE_V2), 'descriptor');
  const t = d.template;
  checkAscii(t, 'template');
  if (version === 1 && t.layout !== 'fixed-root') throw new Error(`layout ${t.layout} is not fixed-root`);
  if (templateHash(t) !== d.template_hash) throw new Error('template_hash does not match the template');
  for (const c of d.chains) if (c.genesis !== null) unhex(c.genesis, 32);
  checkModel(model(d));
}

// Checks JSON text before it is parsed. JSON.parse reads 9007199254740993 as
// 9007199254740992 and 1.0 as 1, and keeps the last of two fields of one name,
// so every number token must be an integer in [0, 2^53) and no object may name
// a field twice. Returns nothing; throws on the first fault.
export function checkJsonText(text) {
  let i = 0;
  const fail = (why) => { throw new Error(`${why} at offset ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    const start = i;
    i++;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '"') { i++; return JSON.parse(text.slice(start, i)); }
      else i++;
    }
    return fail('an unterminated string');
  };
  let depth = 0;
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      depth++;
      if (depth > MAX_JSON_DEPTH) throw new Error(`the JSON nests deeper than ${MAX_JSON_DEPTH} levels`);
    }
    if (c === '{') {
      i++;
      const keys = new Set();
      ws();
      if (text[i] === '}') { i++; depth--; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('a field name expected');
        const k = str();
        if (keys.has(k)) fail(`field ${k} appears twice`);
        keys.add(k);
        ws();
        if (text[i] !== ':') fail('":" expected');
        i++;
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; depth--; return; }
        fail('"," or "}" expected');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') { i++; depth--; return; }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; depth--; return; }
        fail('"," or "]" expected');
      }
    }
    if (c === '"') { str(); return; }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
      const token = m ? m[0] : c;
      if (!/^[0-9]+$/.test(token) || BigInt(token) >= 2n ** 53n) {
        throw new Error(`${token} is not an integer in [0, 2^53)`);
      }
      i += token.length;
      return;
    }
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) { i += lit.length; return; }
    }
    fail('not JSON');
  };
  value();
  ws();
  if (i !== text.length) fail('trailing data');
}

// JSON text, checked as checkJsonText checks it, then parsed.
export function parseJson(text) {
  checkJsonText(text);
  return JSON.parse(text);
}

// Read a descriptor from JSON text, refusing what checkJsonText and
// checkDescriptor refuse.
export function parseDescriptor(text) {
  const d = parseJson(text);
  checkDescriptor(d);
  return d;
}

const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

export function tagged(tag, msg) {
  const t = sha256(Buffer.from(tag, 'utf8'));
  return sha256(concat(t, t, msg));
}

// Object keys sorted, no whitespace. Templates are printable ASCII.
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function templateHash(template) {
  return hex(sha256(Buffer.from(canonicalJson(template), 'utf8')));
}

function checkRoleValue(role, b) {
  if (role === 'pubkey') liftX(big(b));
  if (role === 'sequence') {
    const v = Buffer.from(b).readUInt32BE(0);
    if ((v & ~SEQUENCE_BITS) >>> 0 !== 0) {
      throw new Error(`sequence 0x${v.toString(16).padStart(8, '0')} sets a bit outside the type flag and the 16-bit lock`);
    }
  }
}

function valueOf(m, values, name) {
  const [p] = field(m, name);
  try {
    const b = unhex(values[name], WIDTHS[p.type]);
    checkRoleValue(p.role, b);
    return b;
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
}

// The data leaf's bytes of a version 1 template.
export function paramBytes(template, params) {
  if (Object.keys(params).length !== template.params.length) {
    throw new Error('wrong number of parameters');
  }
  return concat(...template.params.map((p) => {
    if (!own(params, p.name)) throw new Error(`parameter ${p.name} is missing`);
    try {
      return unhex(params[p.name], WIDTHS[p.type]);
    } catch (e) {
      throw new Error(`parameter ${p.name}: ${e.message}`);
    }
  }));
}

// A minimal push of v (a BigInt) as a script number.
export function scriptNum(v) {
  if (v === 0n) return Uint8Array.of(0x00);
  if (v <= 16n) return Uint8Array.of(0x50 + Number(v));
  const bytes = [];
  for (let x = v; x > 0n; x >>= 8n) bytes.push(Number(x & 0xffn));
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return Uint8Array.of(bytes.length, ...bytes);
}

function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return new Uint8Array(b);
}

const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a) {
  let [t, newT, r, newR] = [0n, 1n, P, mod(a)];
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  return mod(t);
}
function add(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null;
  const lam = a[0] === b[0] && a[1] === b[1]
    ? mod(3n * a[0] * a[0] * inv(2n * a[1]))
    : mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(lam * lam - a[0] - b[0]);
  return [x, mod(lam * (a[0] - x) - a[1])];
}
function mul(k, pt) {
  let acc = null;
  while (k > 0n) {
    if (k & 1n) acc = add(acc, pt);
    pt = add(pt, pt);
    k >>= 1n;
  }
  return acc;
}
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}
function liftX(x) {
  if (x >= P) throw new Error('not a point');
  const c = mod(x ** 3n + 7n);
  const y = pow(c, (P + 1n) / 4n);
  if (mod(y * y) !== c) throw new Error('not a point');
  return [x, y % 2n === 0n ? y : P - y];
}
const big = (b) => BigInt('0x' + (hex(b) || '0'));
const bytes32 = (n) => unhex(n.toString(16).padStart(64, '0'), 32);

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ gen[i]) >>> 0;
  }
  return chk;
}

// bech32m (BIP350), witness version 1.
export function segwitV1Address(hrp, program) {
  const data = [1];
  let acc = 0;
  let bits = 0;
  for (const b of program) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >> bits) & 31);
    }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const hrpExp = [...hrp].map((c) => c.charCodeAt(0) >> 5)
    .concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = (polymod(hrpExp.concat(data, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3) >>> 0;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(checksum).map((d) => CHARSET[d]).join('');
}

const sameKeys = (obj, names) => {
  const a = Object.keys(obj).sort();
  const b = [...names].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
};

// Every leaf hash, control block, script and data of an instance, its Merkle
// root, tweak, output key and parity, and its scriptPubKey.
export function deriveTree(m, params, slots) {
  if (!sameKeys(params, m.params.map((p) => p.name))) throw new Error('the parameters given are not the template\'s');
  if (!sameKeys(slots, m.slots.map((p) => p.name))) throw new Error('the slots given are not the template\'s');
  const values = { ...params, ...slots };
  const leaves = {};
  const scripts = [];
  const walk = (node) => {
    if (node.kind === 'branch') {
      const [a, la] = walk(node.a);
      const [b, lb] = walk(node.b);
      const [lo, hi] = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
      const h = tagged('TapBranch/elements', concat(lo, hi));
      return [h, [...la.map(([n, path]) => [n, [...path, b]]), ...lb.map(([n, path]) => [n, [...path, a]])]];
    }
    const { kind, name, body } = node;
    if (kind === 'data') {
      const data = concat(...body.map((v) => valueOf(m, values, v)));
      const h = tagged('TapData', data);
      leaves[name] = { hash: hex(h), data: hex(data) };
      return [h, []];
    }
    let script;
    let version;
    if (kind === 'simplicity') {
      script = unhex(body.cmr, 32);
      version = LEAF_VERSION_SIMPLICITY;
    } else {
      version = LEAF_VERSION_TAPSCRIPT;
      script = concat(...body.map(({ k, v }) => {
        if (k === 'bytes') return v;
        const b = valueOf(m, values, v);
        if (k === 'push') return concat([b.length], b);
        return scriptNum(big(b));
      }));
    }
    const h = tagged('TapLeaf/elements', concat([version], compactSize(script.length), script));
    scripts.push([name, version, hex(script)]);
    leaves[name] = { hash: hex(h) };
    if (kind === 'tapscript') leaves[name].script = hex(script);
    return [h, [[name, []]]];
  };
  const [root, paths] = walk(m.tree);
  for (let i = 0; i < scripts.length; i++) {
    for (let j = i + 1; j < scripts.length; j++) {
      if (scripts[i][1] === scripts[j][1] && scripts[i][2] === scripts[j][2]) {
        throw new Error(`leaves ${scripts[i][0]} and ${scripts[j][0]} are one script at one leaf version`);
      }
    }
  }
  const internal = unhex(m.internal_key, 32);
  const tweak = tagged('TapTweak/elements', concat(internal, root));
  const q = add(liftX(big(internal)), mul(big(tweak) % N, G));
  const outputKey = bytes32(q[0]);
  const parity = Number(q[1] & 1n);
  const versions = Object.fromEntries(scripts.map(([n, v]) => [n, v]));
  for (const [name, path] of paths) {
    leaves[name].control_block = hex(concat([versions[name] | parity], internal, ...path));
  }
  return {
    leaves,
    merkle_root: hex(root),
    tweak: hex(tweak),
    output_key: hex(outputKey),
    output_key_parity: parity,
    script_pubkey: '5120' + hex(outputKey),
  };
}

// An instance's output. For a version 1 descriptor, the fields of a version 1
// vector; for version 2, those of a version 2 vector.
export function derive(descriptor, params, slots = {}) {
  checkDescriptor(descriptor);
  const m = model(descriptor);
  const x = deriveTree(m, params, slots);
  const address = {};
  for (const c of descriptor.chains) address[c.name] = segwitV1Address(c.bech32_hrp, unhex(x.output_key, 32));
  if (descriptor.descriptor === 1) {
    return {
      param_bytes: hex(paramBytes(descriptor.template, params)),
      data_leaf: x.leaves[V1_DATA_LEAF].hash,
      program_leaf: x.leaves[V1_PROGRAM_LEAF].hash,
      merkle_root: x.merkle_root,
      tweak: x.tweak,
      output_key: x.output_key,
      output_key_parity: x.output_key_parity,
      script_pubkey: x.script_pubkey,
      address,
    };
  }
  return { ...x, address };
}

// ---- The pool split covenant (templates/pool_split, pool_split_tap3) -------

export const POOL_SPLIT_MAX_ROWS = 63;

// The TABLE parameter of templates/pool_split: SHA256 over the rows in order,
// each the SHA256 of its scriptPubKey then its numerator as 4 big-endian bytes.
// `rows` is [[scriptPubKey bytes, numerator]].
export function poolSplitTable(rows) {
  const parts = [];
  for (const [script, num] of rows) {
    if (!Number.isInteger(num) || num < 0 || num >= 2 ** 32) throw new Error('a numerator is a 32-bit number');
    const n = Buffer.alloc(4);
    n.writeUInt32BE(num);
    parts.push(createHash('sha256').update(Buffer.from(script)).digest(), n);
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

// What a claim pays each row, row 0 first, as BigInts: of `collected`, at most
// capBp / 10,000 is withheld; each row from 1 gets floor(net * numerator /
// denom) of net = collected - withheld, and row 0 the rest. Throws for a claim
// the covenant refuses. Amounts are BigInts.
export function poolSplitPayouts(numerators, denom, capBp, collected, withheld) {
  const D = BigInt(denom);
  const cap = BigInt(capBp);
  const S = BigInt(collected);
  const W = BigInt(withheld);
  if (D <= 0n || D >= 1n << 32n || cap < 0n || cap >= 1n << 16n) throw new Error('denominator or cap out of range');
  if (S < 0n || S >= 1n << 64n || W < 0n || W >= 1n << 64n) throw new Error('amount out of range');
  if (W * 10000n > S * cap) throw new Error('withheld over the cap');
  if (W > S) throw new Error('withheld over what is collected');
  const net = S - W;
  const shares = numerators.slice(1).map((n) => (net * BigInt(n)) / D);
  const paid = shares.reduce((a, b) => a + b, 0n);
  if (paid > net) throw new Error('the rows are owed more than the claim holds');
  return [net - paid, ...shares];
}
