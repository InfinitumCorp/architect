/** Minimal protobuf reader for v2ray GeoIPList and GeoSiteList messages. */

export class GeoDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoDataError";
  }
}

export interface ProtoField {
  id: number;
  wire: number;
  varint?: number;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  while (pos < buf.length && shift <= 49) {
    const byte = buf[pos]!;
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw new GeoDataError("protobuf varint is out of range");
      return { value, pos };
    }
    shift += 7;
  }
  throw new GeoDataError("truncated protobuf");
}

/** Walk one protobuf message. Unknown fixed-width fields are skipped. */
export function eachField(buf: Uint8Array, fn: (field: ProtoField) => void): void {
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.pos;
    const id = key.value >>> 3;
    const wire = key.value & 7;
    if (id === 0) throw new GeoDataError("invalid protobuf field");
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      fn({ id, wire, varint: v.value });
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      if (len.value < 0 || pos + len.value > buf.length) throw new GeoDataError("truncated protobuf");
      const bytes = buf.subarray(pos, pos + len.value);
      pos += len.value;
      fn({ id, wire, bytes });
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new GeoDataError("truncated protobuf");
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new GeoDataError("truncated protobuf");
      pos += 8;
    } else {
      throw new GeoDataError("unsupported protobuf wire type");
    }
  }
}

export function protoText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
