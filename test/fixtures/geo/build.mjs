// Tiny synthetic v2ray GeoIPList / GeoSiteList fixtures. Not the upstream data sets.
//   node test/fixtures/geo/build.mjs --write
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

function varint(n) {
  const out = [];
  let x = n >>> 0;
  while (x > 0x7f) {
    out.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  out.push(x);
  return out;
}

function key(field, wire) {
  return varint((field << 3) | wire);
}

function lenField(field, data) {
  const bytes = data instanceof Uint8Array ? [...data] : data;
  return [...key(field, 2), ...varint(bytes.length), ...bytes];
}

function strField(field, value) {
  return lenField(field, Buffer.from(value, "utf8"));
}

function viField(field, n) {
  return [...key(field, 0), ...varint(n)];
}

function cidr(octets, prefix) {
  return Uint8Array.from([...lenField(1, Uint8Array.from(octets)), ...viField(2, prefix)]);
}

function geoip(code, cidrs, reverse = false) {
  const parts = [...strField(1, code)];
  for (const item of cidrs) parts.push(...lenField(2, item));
  if (reverse) parts.push(...viField(3, 1));
  return Uint8Array.from(parts);
}

function wrapList(entries) {
  const parts = [];
  for (const entry of entries) parts.push(...lenField(1, entry));
  return Buffer.from(parts);
}

function domain(type, value, attribute) {
  const parts = [...viField(1, type), ...strField(2, value)];
  if (attribute) parts.push(...lenField(3, Uint8Array.from(strField(1, attribute))));
  return Uint8Array.from(parts);
}

function geosite(code, domains) {
  const parts = [...strField(1, code)];
  for (const item of domains) parts.push(...lenField(2, item));
  return Uint8Array.from(parts);
}

const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Countries: us, cn, de. private is not a country. zz is reverse_match and must not win. */
export function syntheticGeoIp() {
  return wrapList([
    geoip("us", [cidr([1, 2, 3, 0], 24), cidr([8, 8, 8, 8], 32), cidr([10, 1, 0, 0], 16)]),
    geoip("cn", [cidr([1, 2, 4, 0], 24), cidr([10, 1, 2, 0], 24)]),
    geoip("private", [cidr([10, 0, 0, 0], 8)]),
    geoip("de", [cidr(v6, 32)]),
    geoip("zz", [cidr([0, 0, 0, 0], 0)], true),
  ]);
}

/** Categories: google (domain + full), ads (plain + regex), cn (domain, with an attribute). */
export function syntheticGeoSite() {
  return wrapList([
    geosite("google", [domain(2, "google.com"), domain(3, "mail.google.com")]),
    geosite("ads", [domain(0, "doubleclick"), domain(1, String.raw`^ads\.`)]),
    geosite("cn", [domain(2, "baidu.com", "cn")]),
  ]);
}

if (process.argv.includes("--write")) {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "geoip.dat"), syntheticGeoIp());
  writeFileSync(path.join(dir, "geosite.dat"), syntheticGeoSite());
}
