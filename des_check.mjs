#!/usr/bin/env node
/**
 * des_check.mjs —— 验证自带 DES 实现与站点 CryptoJS 的口径一致
 *   node scripts/des_check.mjs
 */

const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,
             63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,
             41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,
            57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,
            36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,
           24,25,26,27,28,29,28,29,30,31,32,1];
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,
   4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,
   0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,
   13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,
   10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,
   4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,
   9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,
   1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,
   7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const permute = (bits, table) => table.map((p) => bits[p - 1]);
const bitsOf = (buf) => {
  const out = new Array(buf.length * 8);
  for (let i = 0; i < buf.length; i += 1) for (let j = 0; j < 8; j += 1) out[i * 8 + j] = (buf[i] >> (7 - j)) & 1;
  return out;
};
const bytesOf = (bits) => {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i += 1) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
};
const xorBits = (a, b) => a.map((v, i) => v ^ b[i]);
const rotl = (arr, n) => arr.slice(n).concat(arr.slice(0, n));

function subkeysOf(keyBytes) {
  const k = permute(bitsOf(keyBytes), PC1);
  let c = k.slice(0, 28), d = k.slice(28);
  const out = [];
  for (let i = 0; i < 16; i += 1) {
    c = rotl(c, SHIFTS[i]); d = rotl(d, SHIFTS[i]);
    out.push(permute(c.concat(d), PC2));
  }
  return out;
}

function feistel(r, k) {
  const x = xorBits(permute(r, E), k);
  const out = [];
  for (let i = 0; i < 8; i += 1) {
    const b = x.slice(i * 6, i * 6 + 6);
    const row = (b[0] << 1) | b[5];
    const col = (b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4];
    const v = SBOX[i][row * 16 + col];
    out.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return permute(out, P);
}

export function desEncryptBytes(plain, keyBytes) {
  const pad = 8 - (plain.length % 8);
  const data = new Uint8Array(plain.length + pad);
  data.set(plain);
  data.fill(pad, plain.length);
  const subkeys = subkeysOf(keyBytes);
  const out = new Uint8Array(data.length);
  for (let off = 0; off < data.length; off += 8) {
    const bits = permute(bitsOf(data.slice(off, off + 8)), IP);
    let l = bits.slice(0, 32), r = bits.slice(32);
    for (let i = 0; i < 16; i += 1) {
      const nl = r;
      const nr = xorBits(l, feistel(r, subkeys[i]));
      l = nl; r = nr;
    }
    out.set(bytesOf(permute(r.concat(l), FP)), off);
  }
  return out;
}

export function desEncryptBase64(text, key = "csg_spoc") {
  const bytes = desEncryptBytes(new TextEncoder().encode(text), new TextEncoder().encode(key));
  return Buffer.from(bytes).toString("base64");
}

if (process.argv[1] && process.argv[1].endsWith("des_check.mjs")) {
  const cases = [
    ["使用netstat侦测到的端口有哪几种常见状态，简要解释",
     "CeTPJk4D8UWjyGm94ynx1+zZ74kZWulIcumRL20PBu8xBb/t98bYYUZg6P8Lqp1bQEkb2TfI97MS9PWMQps02hhmRL2OpriK"],
    ["LISTEN、ESTABLISHED、TIME_WAIT、CLOSE_WAIT、SYN_SENT",
     "Yi7MVdmVMgpffqRhBbC7JvIAVGBVqVGFfzE8axxIoegc+TrUK6lsnE01QXnlt5BSUxeZ8x4HEaL1B87DT5agiA=="],
    ["<p>hello <b>world</b></p>", "3kDwlpQh3TnwU5QpzYt6aOkzdJMv4YeHHxo1hXBbNCM="],
    ["", "9QfOw0+WoIg="],
    ["a", "uxllTOG9Lhs="],
  ];
  let ok = true;
  for (const [plain, want] of cases) {
    const got = desEncryptBase64(plain);
    const same = got === want;
    if (!same) ok = false;
    console.log(`${same ? "一致" : "不一致"}  ${JSON.stringify(plain).slice(0, 30)}`);
    if (!same) { console.log("  got :", got); console.log("  want:", want); }
  }
  console.log(ok ? "\n结论：自带 DES 与站点 CryptoJS 口径一致。" : "\n结论：不一致，需要修。");
  process.exit(ok ? 0 : 1);
}
