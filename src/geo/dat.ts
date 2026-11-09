/**
 * Loader for v2ray GeoIPList / GeoSiteList (.dat) files.
 *
 * geoip.dat is a GeoIPList: IP address to a list code. Two-letter codes are countries.
 * geosite.dat is a GeoSiteList: domain to a category code.
 * Match rules follow the v2ray domain types: plain (substring), regex, domain (suffix), full.
 */

import { GeoDataError, eachField, protoText } from "./protobuf.js";

interface V4Range {
  start: number;
  end: number;
  prefix: number;
  code: string;
}

interface V6Range {
  bytes: Uint8Array;
  prefix: number;
  code: string;
}

class GeoIpIndex {
  private v4wide: V4Range[] = [];
  private v4 = new Map<number, V4Range[]>();
  private v6wide: V6Range[] = [];
  private v6 = new Map<number, V6Range[]>();

  add(code: string, ip: Uint8Array, prefix: number, reverse: boolean): void {
    // reverse_match lists mean "everything except these addresses", not a country.
    if (reverse) return;
    const country = code.trim().toLowerCase();
    if (!country) return;
    if (ip.length === 4) this.addV4(country, ip, prefix);
    else if (ip.length === 16) this.addV6(country, ip, prefix);
  }

  countryOf(ip: string): string | null {
    const parsed = parseIp(ip);
    if (!parsed) return null;
    let bestCode: string | null = null;
    let bestPrefix = -1;
    const take = (code: string, prefix: number, hit: boolean) => {
      if (!hit || !/^[a-z]{2}$/.test(code)) return;
      if (prefix > bestPrefix) {
        bestPrefix = prefix;
        bestCode = code;
      }
    };
    if (parsed.v4 !== undefined) {
      const n = parsed.v4;
      for (const range of this.v4wide) take(range.code, range.prefix, n >= range.start && n <= range.end);
      const bucket = this.v4.get(n >>> 16);
      if (bucket) for (const range of bucket) take(range.code, range.prefix, n >= range.start && n <= range.end);
    } else if (parsed.v6) {
      const addr = parsed.v6;
      for (const range of this.v6wide) take(range.code, range.prefix, v6match(addr, range.bytes, range.prefix));
      const bucket = this.v6.get((addr[0]! << 8) | addr[1]!);
      if (bucket) for (const range of bucket) take(range.code, range.prefix, v6match(addr, range.bytes, range.prefix));
    }
    return bestCode;
  }

  private addV4(code: string, ip: Uint8Array, prefix: number): void {
    if (prefix < 0 || prefix > 32) return;
    const raw = ((ip[0]! << 24) | (ip[1]! << 16) | (ip[2]! << 8) | ip[3]!) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const start = (raw & mask) >>> 0;
    const end = (start | (~mask >>> 0)) >>> 0;
    const range = { start, end, prefix, code };
    if (prefix < 16) this.v4wide.push(range);
    else {
      const bucket = start >>> 16;
      const list = this.v4.get(bucket);
      if (list) list.push(range);
      else this.v4.set(bucket, [range]);
    }
  }

  private addV6(code: string, ip: Uint8Array, prefix: number): void {
    if (prefix < 0 || prefix > 128) return;
    const bytes = maskV6(ip, prefix);
    const range = { bytes, prefix, code };
    if (prefix < 16) this.v6wide.push(range);
    else {
      const bucket = (bytes[0]! << 8) | bytes[1]!;
      const list = this.v6.get(bucket);
      if (list) list.push(range);
      else this.v6.set(bucket, [range]);
    }
  }
}

class GeoSiteIndex {
  private full = new Map<string, string[]>();
  private suffix = new Map<string, string[]>();
  private plain: { value: string; category: string }[] = [];
  private regex: { re: RegExp; category: string }[] = [];

  add(category: string, type: number, value: string): void {
    const cat = category.trim().toLowerCase();
    const domain = value.trim().toLowerCase();
    if (!cat || !domain) return;
    if (type === 3) pushCode(this.full, domain, cat);
    else if (type === 2) pushCode(this.suffix, domain, cat);
    else if (type === 1) {
      if (domain.length > 256) return;
      try {
        this.regex.push({ re: new RegExp(domain), category: cat });
      } catch {
        // A pattern that does not compile is skipped. Other rules in the set still apply.
      }
    } else this.plain.push({ value: domain, category: cat });
  }

  categoriesOf(domain: string): string[] {
    const host = normalizeDomain(domain);
    if (!host || parseIp(host)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (codes?: readonly string[]) => {
      for (const code of codes ?? []) {
        if (seen.has(code)) continue;
        seen.add(code);
        out.push(code);
      }
    };
    add(this.full.get(host));
    let rest = host;
    while (rest) {
      add(this.suffix.get(rest));
      const dot = rest.indexOf(".");
      if (dot < 0) break;
      rest = rest.slice(dot + 1);
    }
    for (const rule of this.plain) if (host.includes(rule.value)) add([rule.category]);
    for (const rule of this.regex) {
      rule.re.lastIndex = 0;
      if (rule.re.test(host)) add([rule.category]);
    }
    return out;
  }
}

function pushCode(map: Map<string, string[]>, key: string, code: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(code)) list.push(code);
  } else map.set(key, [code]);
}

function maskV6(ip: Uint8Array, prefix: number): Uint8Array {
  const out = ip.slice();
  const full = prefix >> 3;
  const rem = prefix & 7;
  if (rem && full < 16) out[full] = out[full]! & ((0xff << (8 - rem)) & 0xff);
  for (let i = full + (rem ? 1 : 0); i < 16; i++) out[i] = 0;
  return out;
}

function v6match(addr: Uint8Array, net: Uint8Array, prefix: number): boolean {
  const full = prefix >> 3;
  for (let i = 0; i < full; i++) if (addr[i] !== net[i]) return false;
  const rem = prefix & 7;
  if (!rem) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (addr[full]! & mask) === (net[full]! & mask);
}

function parseV4(raw: string): { v4: number } | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    n = n * 256 + value;
  }
  return { v4: n >>> 0 };
}

function groupsToBytes(groups: number[]): Uint8Array {
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    out[i * 2] = (group >> 8) & 0xff;
    out[i * 2 + 1] = group & 0xff;
  });
  return out;
}

function expandGroups(parts: string[]): number[] | null {
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes(".")) {
      if (i !== parts.length - 1) return null;
      const v4 = parseV4(part);
      if (!v4) return null;
      groups.push((v4.v4 >>> 16) & 0xffff, v4.v4 & 0xffff);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
  }
  return groups;
}

/** Parse an IP address. IPv4-mapped IPv6 is returned as IPv4. */
export function parseIp(input: string): { v4?: number; v6?: Uint8Array } | null {
  const raw = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!raw || raw.includes("%")) return null;
  if (!raw.includes(":")) return parseV4(raw);
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return parseV4(mapped[1]!);
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? expandGroups(halves[0].split(":")) : [];
  const tail = halves.length === 2 && halves[1] ? expandGroups(halves[1].split(":")) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  }
  const bytes = groupsToBytes(groups);
  const v4mapped =
    bytes[10] === 0xff &&
    bytes[11] === 0xff &&
    bytes.subarray(0, 10).every((b) => b === 0);
  if (v4mapped) {
    const n = ((bytes[12]! << 24) | (bytes[13]! << 16) | (bytes[14]! << 8) | bytes[15]!) >>> 0;
    return { v4: n };
  }
  return { v6: bytes };
}

function normalizeDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("*.")) host = host.slice(2);
  return host;
}

function loadGeoIp(bytes: Uint8Array): GeoIpIndex {
  const index = new GeoIpIndex();
  eachField(bytes, (field) => {
    if (field.id !== 1 || !field.bytes) return;
    let code = "";
    let reverse = false;
    const cidrs: { ip: Uint8Array; prefix: number }[] = [];
    eachField(field.bytes, (entry) => {
      if (entry.id === 1 && entry.bytes) code = protoText(entry.bytes);
      else if (entry.id === 3 && entry.varint !== undefined) reverse = entry.varint !== 0;
      else if (entry.id === 2 && entry.bytes) {
        let ip: Uint8Array | undefined;
        let prefix = 0;
        eachField(entry.bytes, (cidr) => {
          if (cidr.id === 1 && cidr.bytes) ip = cidr.bytes;
          else if (cidr.id === 2 && cidr.varint !== undefined) prefix = cidr.varint;
        });
        if (ip && (ip.length === 4 || ip.length === 16)) cidrs.push({ ip, prefix });
      }
    });
    for (const cidr of cidrs) index.add(code, cidr.ip, cidr.prefix, reverse);
  });
  return index;
}

function loadGeoSite(bytes: Uint8Array): GeoSiteIndex {
  const index = new GeoSiteIndex();
  eachField(bytes, (field) => {
    if (field.id !== 1 || !field.bytes) return;
    let code = "";
    const domains: { type: number; value: string }[] = [];
    eachField(field.bytes, (entry) => {
      if (entry.id === 1 && entry.bytes) code = protoText(entry.bytes);
      else if (entry.id === 2 && entry.bytes) {
        let type = 0;
        let value = "";
        eachField(entry.bytes, (domain) => {
          if (domain.id === 1 && domain.varint !== undefined) type = domain.varint;
          else if (domain.id === 2 && domain.bytes) value = protoText(domain.bytes);
        });
        if (value) domains.push({ type, value });
      }
    });
    for (const domain of domains) index.add(code, domain.type, domain.value);
  });
  return index;
}

/** Country and category lookups over one geoip set and one geosite set. */
export interface GeoData {
  /** Two-letter country code, or null when the address is not in a country list. */
  countryOf(ip: string): string | null;
  /** Category codes whose geosite rules match the domain, in list order. */
  categoriesOf(domain: string): string[];
}

class GeoDataSet implements GeoData {
  constructor(
    private readonly ip: GeoIpIndex,
    private readonly site: GeoSiteIndex,
  ) {}

  countryOf(ip: string): string | null {
    return this.ip.countryOf(ip);
  }

  categoriesOf(domain: string): string[] {
    return this.site.categoriesOf(domain);
  }
}

export function geoFromBytes(geoip: Uint8Array, geosite: Uint8Array): GeoData {
  return new GeoDataSet(loadGeoIp(geoip), loadGeoSite(geosite));
}

export { GeoDataError };
