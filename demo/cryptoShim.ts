// Browser stand-in for `node:crypto`, swapped in by scripts/build-demo.ts
// (esbuild `alias`). The shared rules the demo bundles (issueRules.ts →
// syncMerge.ts) use exactly two exports: `randomUUID` for new-ticket guids and
// `createHash("sha1")` for `deriveGuid` / canonical content hashes. Anything
// else throws, so a new node:crypto use in the shared code fails loudly in the
// demo instead of hashing differently.

export function randomUUID(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  // `crypto.randomUUID` is secure-context only (https / localhost). A demo
  // served over plain http on a LAN IP still gets a well-formed v4 uuid.
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Hash {
  update(data: string): Hash;
  digest(encoding: "hex"): string;
}

export function createHash(algorithm: string): Hash {
  if (algorithm !== "sha1") throw new Error(`demo crypto shim: unsupported hash ${algorithm}`);
  const parts: string[] = [];
  const hash: Hash = {
    update(data) {
      parts.push(data);
      return hash;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new Error(`demo crypto shim: unsupported encoding ${encoding}`);
      return sha1Hex(new TextEncoder().encode(parts.join("")));
    },
  };
  return hash;
}

/** Plain SHA-1 (FIPS 180-4). Synchronous because `deriveGuid` is. */
export function sha1Hex(msg: Uint8Array): string {
  const bitLen = msg.length * 8;
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}
