import { isIP } from "node:net";
import { encodeBytesField, encodeStringField, encodeVarintField, fieldMessages, fieldString, fieldVarint, readMessage } from "./protobuf.js";

/**
 * v2ray routercommon GeoIP / GeoSite.
 * Domain types: Plain 0, Regex 1, RootDomain 2, Full 3.
 * GeoIP.inverse_match (field 3) matches addresses outside the entry's CIDRs.
 */

export interface Cidr {
  ip: Uint8Array;
  prefix: number;
}

export interface GeoIpEntry {
  country: string;
  cidrs: Cidr[];
  inverse: boolean;
}

export interface GeoSiteRule {
  type: number;
  value: string;
}

export interface GeoSiteEntry {
  category: string;
  domains: GeoSiteRule[];
}

const PLAIN = 0;
const REGEX = 1;
const ROOT = 2;
const FULL = 3;

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

function encodeCidr(cidr: Cidr): Uint8Array {
  return concat([encodeBytesField(1, cidr.ip), encodeVarintField(2, cidr.prefix)]);
}

export function encodeGeoIpList(entries: GeoIpEntry[]): Uint8Array {
  return concat(entries.map((entry) => {
    const parts = [encodeStringField(1, entry.country)];
    for (const cidr of entry.cidrs) parts.push(encodeBytesField(2, encodeCidr(cidr)));
    if (entry.inverse) parts.push(encodeVarintField(3, 1));
    return encodeBytesField(1, concat(parts));
  }));
}

export function encodeGeoSiteList(entries: GeoSiteEntry[]): Uint8Array {
  return concat(entries.map((entry) => {
    const parts = [encodeStringField(1, entry.category)];
    for (const domain of entry.domains) {
      const body = concat([
        domain.type ? encodeVarintField(1, domain.type) : new Uint8Array(),
        encodeStringField(2, domain.value),
      ]);
      parts.push(encodeBytesField(2, body));
    }
    return encodeBytesField(1, concat(parts));
  }));
}

export function decodeGeoIpList(buf: Uint8Array): GeoIpEntry[] {
  return fieldMessages(readMessage(buf), 1).map((raw) => {
    const fields = readMessage(raw);
    const cidrs = fieldMessages(fields, 2).map((cidrRaw) => {
      const cidr = readMessage(cidrRaw);
      const ip = fieldMessages(cidr, 1)[0] ?? new Uint8Array();
      return { ip, prefix: fieldVarint(cidr, 2) ?? 0 };
    });
    return {
      country: fieldString(fields, 1) ?? "",
      cidrs,
      inverse: fieldVarint(fields, 3) === 1,
    };
  });
}

export function decodeGeoSiteList(buf: Uint8Array): GeoSiteEntry[] {
  return fieldMessages(readMessage(buf), 1).map((raw) => {
    const fields = readMessage(raw);
    const domains = fieldMessages(fields, 2).map((domainRaw) => {
      const domain = readMessage(domainRaw);
      return { type: fieldVarint(domain, 1) ?? PLAIN, value: fieldString(domain, 2) ?? "" };
    });
    return { category: fieldString(fields, 1) ?? "", domains };
  });
}

export function parseIp(input: string): { family: 4 | 6; bytes: Uint8Array } | null {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const mapped = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : "";
  if (mapped && isIP(mapped) === 4) return { family: 4, bytes: ipv4Bytes(mapped) };
  if (isIP(host) === 4) return { family: 4, bytes: ipv4Bytes(host) };
  if (isIP(host) === 6) return { family: 6, bytes: ipv6Bytes(host) };
  return null;
}

function ipv4Bytes(ip: string): Uint8Array {
  return Uint8Array.from(ip.split(".").map((p) => Number(p)));
}

function ipv6Bytes(ip: string): Uint8Array {
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  if (ip.includes("::")) {
    const missing = 8 - left.length - right.length;
    const groups = [...left, ...Array(missing).fill("0"), ...right];
    return groupsToBytes(groups);
  }
  return groupsToBytes(ip.split(":"));
}

function groupsToBytes(groups: string[]): Uint8Array {
  const out = new Uint8Array(16);
  groups.slice(0, 8).forEach((group, i) => {
    const n = Number.parseInt(group || "0", 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

export function cidrContains(ip: Uint8Array, network: Uint8Array, prefix: number): boolean {
  if (ip.length !== network.length || prefix < 0) return false;
  if (prefix === 0) return true;
  if (prefix > ip.length * 8) return false;
  const full = Math.floor(prefix / 8);
  const rem = prefix % 8;
  for (let i = 0; i < full; i++) if (ip[i] !== network[i]) return false;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((ip[full]! & mask) === (network[full]! & mask));
}

interface PositiveHit {
  country: string;
  prefix: number;
}

/** Longest positive CIDR wins. An inverse entry is used only when nothing positive matches. */
export class GeoIpList {
  private v4 = new Map<number, GeoIpEntry[]>();
  private v4Wide: GeoIpEntry[] = [];
  private v6: GeoIpEntry[] = [];

  constructor(readonly entries: GeoIpEntry[]) {
    for (const entry of entries) {
      if (!entry.country) continue;
      const v4 = entry.cidrs.some((c) => c.ip.length === 4 && c.prefix < 8);
      const v6 = entry.cidrs.some((c) => c.ip.length === 16);
      if (v4 || entry.inverse) this.v4Wide.push(entry);
      if (v6 || entry.inverse) this.v6.push(entry);
      if (!entry.inverse) {
        for (const cidr of entry.cidrs) {
          if (cidr.ip.length !== 4 || cidr.prefix < 8) continue;
          const first = cidr.ip[0]!;
          const last = cidr.prefix >= 8 ? first : 255;
          for (let octet = first; octet <= last; octet++) {
            const bucket = this.v4.get(octet) ?? [];
            bucket.push(entry);
            this.v4.set(octet, bucket);
          }
        }
      }
    }
  }

  countryFor(ip: string): string | undefined {
    const parsed = parseIp(ip);
    if (!parsed) return undefined;
    const candidates = parsed.family === 4
      ? [...(this.v4.get(parsed.bytes[0]!) ?? []), ...this.v4Wide]
      : this.v6;
    let best: PositiveHit | undefined;
    let inverse: string | undefined;
    const seen = new Set<GeoIpEntry>();
    for (const entry of candidates) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      const cidrs = entry.cidrs.filter((c) => c.ip.length === parsed.bytes.length);
      if (cidrs.length === 0 && !entry.inverse) continue;
      let longest = -1;
      for (const cidr of cidrs) {
        if (cidrContains(parsed.bytes, cidr.ip, cidr.prefix) && cidr.prefix > longest) longest = cidr.prefix;
      }
      const inside = longest >= 0;
      if (entry.inverse) {
        if (cidrs.length === 0) continue;
        if (!inside && inverse === undefined) inverse = entry.country;
      } else if (inside && (!best || longest > best.prefix)) {
        best = { country: entry.country, prefix: longest };
      }
    }
    return best?.country ?? inverse;
  }
}

interface SiteHit {
  category: string;
  order: number;
}

export class GeoSiteList {
  private full = new Map<string, SiteHit[]>();
  private root = new Map<string, SiteHit[]>();
  private plain: { value: string; hit: SiteHit }[] = [];
  private regex: { re: RegExp; hit: SiteHit }[] = [];

  constructor(readonly entries: GeoSiteEntry[]) {
    entries.forEach((entry, order) => {
      if (!entry.category) return;
      const hit = { category: entry.category, order };
      for (const domain of entry.domains) {
        const value = domain.value.trim().toLowerCase();
        if (!value) continue;
        if (domain.type === FULL) addHit(this.full, value, hit);
        else if (domain.type === ROOT) addHit(this.root, value, hit);
        else if (domain.type === REGEX) {
          if (value.length > 512) continue;
          try {
            this.regex.push({ re: new RegExp(value), hit });
          } catch {
            /* skip a rule that is not a valid expression */
          }
        } else addPlain(this.plain, value, hit);
      }
    });
  }

  categoriesFor(domain: string): string[] {
    const host = normalizeDomain(domain);
    if (!host) return [];
    const matched = new Map<string, number>();
    const take = (hits?: SiteHit[]) => {
      if (!hits) return;
      for (const hit of hits) if (!matched.has(hit.category)) matched.set(hit.category, hit.order);
    };
    take(this.full.get(host));
    const labels = host.split(".");
    for (let i = 0; i < labels.length; i++) take(this.root.get(labels.slice(i).join(".")));
    for (const rule of this.plain) if (host.includes(rule.value)) take([rule.hit]);
    for (const rule of this.regex) {
      try {
        if (rule.re.test(host)) take([rule.hit]);
      } catch {
        /* one expression failed; keep the rest */
      }
    }
    return [...matched.entries()].sort((a, b) => a[1] - b[1]).map(([category]) => category);
  }
}

function addHit(map: Map<string, SiteHit[]>, key: string, hit: SiteHit) {
  const list = map.get(key) ?? [];
  list.push(hit);
  map.set(key, list);
}

function addPlain(list: { value: string; hit: SiteHit }[], value: string, hit: SiteHit) {
  list.push({ value, hit });
}

export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase();
  if (!host) return "";
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {
    /* keep the raw token */
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

export function loadGeoIpList(bytes: Uint8Array): GeoIpList {
  return new GeoIpList(decodeGeoIpList(bytes));
}

export function loadGeoSiteList(bytes: Uint8Array): GeoSiteList {
  return new GeoSiteList(decodeGeoSiteList(bytes));
}
