/** Minimal protobuf codec for v2ray GeoIPList and GeoSiteList. No extra dependencies. */

export interface ProtoField {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let o = offset;
  while (o < buf.length && shift <= 49) {
    const byte = buf[o++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, o];
    shift += 7;
  }
  throw new Error("truncated protobuf varint");
}

export function encodeVarint(n: number): Uint8Array {
  if (!Number.isFinite(n) || n < 0) throw new Error("varint must be a non-negative finite number");
  const bytes: number[] = [];
  let x = Math.floor(n);
  while (x > 0x7f) {
    bytes.push((x & 0x7f) | 0x80);
    x = Math.floor(x / 128);
  }
  bytes.push(x);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function key(field: number, wire: number): Uint8Array {
  return encodeVarint(field * 8 + wire);
}

export function encodeBytesField(field: number, data: Uint8Array): Uint8Array {
  return concat([key(field, 2), encodeVarint(data.length), data]);
}

export function encodeStringField(field: number, value: string): Uint8Array {
  return encodeBytesField(field, new TextEncoder().encode(value));
}

export function encodeVarintField(field: number, value: number): Uint8Array {
  return concat([key(field, 0), encodeVarint(value)]);
}

/** Walk one message. Unknown wire types 1 and 5 are skipped; groups are rejected. */
export function readMessage(buf: Uint8Array, start = 0, end = buf.length): ProtoField[] {
  const fields: ProtoField[] = [];
  let o = start;
  while (o < end) {
    const [tag, next] = readVarint(buf, o);
    o = next;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      const [value, after] = readVarint(buf, o);
      fields.push({ field, wire, value });
      o = after;
    } else if (wire === 2) {
      const [len, after] = readVarint(buf, o);
      o = after;
      if (len < 0 || o + len > end) throw new Error("truncated protobuf length");
      fields.push({ field, wire, value: buf.subarray(o, o + len) });
      o += len;
    } else if (wire === 1) {
      if (o + 8 > end) throw new Error("truncated protobuf fixed64");
      o += 8;
    } else if (wire === 5) {
      if (o + 4 > end) throw new Error("truncated protobuf fixed32");
      o += 4;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

export function fieldString(fields: ProtoField[], number: number): string | undefined {
  const found = fields.find((f) => f.field === number && f.wire === 2);
  if (!found || typeof found.value === "number") return undefined;
  return new TextDecoder().decode(found.value);
}

export function fieldVarint(fields: ProtoField[], number: number): number | undefined {
  const found = fields.find((f) => f.field === number && f.wire === 0);
  return typeof found?.value === "number" ? found.value : undefined;
}

export function fieldMessages(fields: ProtoField[], number: number): Uint8Array[] {
  return fields
    .filter((f) => f.field === number && f.wire === 2 && typeof f.value !== "number")
    .map((f) => f.value as Uint8Array);
}
