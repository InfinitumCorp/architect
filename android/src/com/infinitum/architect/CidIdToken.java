package com.infinitum.architect;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECFieldFp;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.EllipticCurve;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Verifies a Cumulus://ID ID token on the device before a session is kept, the same checks the
 * desktop app and the extension make (cumulus-id docs/integration.md):
 *
 *   ES256 signature against the issuer's JWKS (P-256 keys, matched by kid; keys are cached and
 *   fetched again once when a token names a kid the cache does not know, i.e. after a rotation),
 *   then iss (always the canonical issuer, also when the keys came from a mirror), aud (this
 *   client; azp when there are several audiences), exp (60 s skew), nonce and a non-empty sub.
 *
 * Only java.security and org.json: no Android imports, so it compiles and is tested on a plain JVM
 * (android/test.sh). JWS ES256 signatures are raw r||s (64 bytes); java.security wants DER, so
 * {@link #joseToDer} converts them.
 */
public final class CidIdToken {
    /** The issuer every Cumulus://ID ID token names, whichever host served it. */
    public static final String ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
    public static final long SKEW_SECONDS = 60;

    /** Reads a URL and returns its body (the JWKS). Blocking; called off the main thread. */
    public interface Fetch {
        String get(String url) throws IOException;
    }

    /** Wall clock in milliseconds; tests pass a fixed one. */
    public interface Clock {
        long millis();
    }

    public static final class Invalid extends Exception {
        Invalid(String why) {
            super(why);
        }
    }

    private final String issuer;
    private final String clientId;
    private final Fetch fetch;
    private final Clock clock;
    /** JWKS URL -> its keys, as last fetched. */
    private final Map<String, List<Key>> cache = new HashMap<>();

    public CidIdToken(String issuer, String clientId, Fetch fetch, Clock clock) {
        this.issuer = issuer;
        this.clientId = clientId;
        this.fetch = fetch;
        this.clock = clock;
    }

    public CidIdToken(String clientId, Fetch fetch) {
        this(ISSUER, clientId, fetch, System::currentTimeMillis);
    }

    private static final class Key {
        final String kid;
        final PublicKey key;

        Key(String kid, PublicKey key) {
            this.kid = kid;
            this.key = key;
        }
    }

    /**
     * Verifies {@code idToken} and returns its claims. {@code jwksUrl} is the certs endpoint of the
     * host that answered the sign-in (the main host or a mirror); {@code nonce} is the one sent with
     * the authorize request. Throws {@link Invalid} with a short reason (never the token).
     */
    public JSONObject verify(String idToken, String nonce, String jwksUrl) throws Invalid {
        String[] parts = idToken == null ? new String[0] : idToken.split("\\.", -1);
        if (parts.length != 3) throw new Invalid("no ID token");
        JSONObject header;
        JSONObject claims;
        byte[] signature;
        try {
            header = new JSONObject(new String(b64urlDecode(parts[0]), StandardCharsets.UTF_8));
            claims = new JSONObject(new String(b64urlDecode(parts[1]), StandardCharsets.UTF_8));
            signature = b64urlDecode(parts[2]);
        } catch (Exception e) {
            throw new Invalid("malformed ID token");
        }
        if (!"ES256".equals(header.optString("alg"))) throw new Invalid("unexpected algorithm");
        if ("at+jwt".equalsIgnoreCase(header.optString("typ", "JWT"))) throw new Invalid("not an ID token");
        if (signature.length != 64) throw new Invalid("bad signature");

        String kid = header.has("kid") ? header.optString("kid", "") : "";
        boolean fresh = false;
        List<Key> keys;
        synchronized (cache) {
            keys = cache.get(jwksUrl);
        }
        if (keys == null) {
            keys = load(jwksUrl);
            fresh = true;
        }
        PublicKey key = pick(keys, kid);
        if (key == null && !fresh) {
            // A kid we have not seen: the issuer may have rotated. Fetch the keys once more.
            key = pick(load(jwksUrl), kid);
        }
        if (key == null) throw new Invalid("signing key not found");

        boolean signed;
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            signed = s.verify(joseToDer(signature));
        } catch (Exception e) {
            signed = false;
        }
        if (!signed) throw new Invalid("bad signature");

        if (!issuer.equals(claims.optString("iss"))) throw new Invalid("wrong issuer");
        List<String> aud = new ArrayList<>();
        Object a = claims.opt("aud");
        if (a instanceof JSONArray) {
            JSONArray arr = (JSONArray) a;
            for (int i = 0; i < arr.length(); i++) aud.add(String.valueOf(arr.opt(i)));
        } else if (a instanceof String) {
            aud.add((String) a);
        }
        if (!aud.contains(clientId)) throw new Invalid("wrong audience");
        if (aud.size() > 1 && !clientId.equals(claims.optString("azp"))) throw new Invalid("wrong audience");
        Object exp = claims.opt("exp");
        long now = clock.millis() / 1000;
        if (!(exp instanceof Number) || ((Number) exp).longValue() + SKEW_SECONDS <= now) throw new Invalid("expired");
        Object iat = claims.opt("iat");
        if (iat instanceof Number && ((Number) iat).longValue() - SKEW_SECONDS > now) throw new Invalid("issued in the future");
        String got = claims.optString("nonce", "");
        if (nonce == null || nonce.isEmpty()
            || !MessageDigest.isEqual(got.getBytes(StandardCharsets.UTF_8), nonce.getBytes(StandardCharsets.UTF_8))) {
            throw new Invalid("nonce mismatch");
        }
        Object sub = claims.opt("sub");
        if (!(sub instanceof String) || ((String) sub).isEmpty()) throw new Invalid("no subject");
        return claims;
    }

    private List<Key> load(String jwksUrl) throws Invalid {
        List<Key> keys;
        try {
            keys = parseJwks(fetch.get(jwksUrl));
        } catch (Invalid e) {
            throw e;
        } catch (Exception e) {
            throw new Invalid("could not fetch signing keys");
        }
        synchronized (cache) {
            cache.put(jwksUrl, keys);
        }
        return keys;
    }

    private static PublicKey pick(List<Key> keys, String kid) {
        for (Key k : keys) {
            if (kid.isEmpty() || kid.equals(k.kid)) return k.key;
        }
        return null;
    }

    /** The P-256 signing keys in a JWKS document. Keys of other types or curves are skipped. */
    static List<Key> parseJwks(String text) throws Invalid {
        List<Key> out = new ArrayList<>();
        JSONArray keys;
        try {
            keys = new JSONObject(text).optJSONArray("keys");
        } catch (Exception e) {
            throw new Invalid("bad JWKS");
        }
        if (keys == null) return out;
        for (int i = 0; i < keys.length(); i++) {
            JSONObject k = keys.optJSONObject(i);
            if (k == null || !"EC".equals(k.optString("kty")) || !"P-256".equals(k.optString("crv"))) continue;
            String use = k.optString("use", "");
            String alg = k.optString("alg", "");
            if (!use.isEmpty() && !"sig".equals(use)) continue;
            if (!alg.isEmpty() && !"ES256".equals(alg)) continue;
            try {
                out.add(new Key(k.optString("kid", ""), p256Key(b64urlDecode(k.getString("x")), b64urlDecode(k.getString("y")))));
            } catch (Exception ignored) {
                // A malformed key is skipped; the token must then match another one.
            }
        }
        return out;
    }

    // ---- P-256 (secp256r1), spelled out so no named-curve lookup is needed on any Android version ----
    private static final BigInteger P = new BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16);
    private static final BigInteger A = new BigInteger("ffffffff00000001000000000000000000000000fffffffffffffffffffffffc", 16);
    private static final BigInteger B = new BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16);
    private static final BigInteger GX = new BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16);
    private static final BigInteger GY = new BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16);
    private static final BigInteger N = new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
    static final ECParameterSpec P256 = new ECParameterSpec(new EllipticCurve(new ECFieldFp(P), A, B), new ECPoint(GX, GY), N, 1);

    /** An EC public key from the JWK's x and y (32 bytes each), after checking the point is on P-256. */
    static PublicKey p256Key(byte[] xb, byte[] yb) throws Exception {
        if (xb.length != 32 || yb.length != 32) throw new IllegalArgumentException("bad coordinate length");
        BigInteger x = new BigInteger(1, xb);
        BigInteger y = new BigInteger(1, yb);
        if (x.compareTo(P) >= 0 || y.compareTo(P) >= 0) throw new IllegalArgumentException("coordinate out of range");
        BigInteger left = y.multiply(y).mod(P);
        BigInteger right = x.pow(3).add(A.multiply(x)).add(B).mod(P);
        if (!left.equals(right)) throw new IllegalArgumentException("point not on P-256");
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), P256));
    }

    /** JOSE ES256 signature (r||s, 32 bytes each) to the DER SEQUENCE { INTEGER r, INTEGER s } java.security verifies. */
    public static byte[] joseToDer(byte[] raw) {
        if (raw.length != 64) throw new IllegalArgumentException("ES256 signatures are 64 bytes");
        byte[] r = derInteger(raw, 0);
        byte[] s = derInteger(raw, 32);
        byte[] out = new byte[2 + r.length + s.length];
        out[0] = 0x30;
        out[1] = (byte) (r.length + s.length); // at most 2 * 35 = 70, so the short length form fits
        System.arraycopy(r, 0, out, 2, r.length);
        System.arraycopy(s, 0, out, 2 + r.length, s.length);
        return out;
    }

    private static byte[] derInteger(byte[] raw, int off) {
        int start = off;
        int end = off + 32;
        while (start < end - 1 && raw[start] == 0) start++;
        boolean pad = (raw[start] & 0x80) != 0;
        int len = end - start + (pad ? 1 : 0);
        byte[] out = new byte[2 + len];
        out[0] = 0x02;
        out[1] = (byte) len;
        System.arraycopy(raw, start, out, 2 + (pad ? 1 : 0), end - start);
        return out;
    }

    /** base64url without padding (java.util.Base64 needs API 26; this app runs from API 24). */
    static byte[] b64urlDecode(String s) {
        int n = s.length();
        byte[] out = new byte[n * 3 / 4];
        int o = 0;
        int buf = 0;
        int bits = 0;
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            int v;
            if (c >= 'A' && c <= 'Z') v = c - 'A';
            else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
            else if (c >= '0' && c <= '9') v = c - '0' + 52;
            else if (c == '-') v = 62;
            else if (c == '_') v = 63;
            else if (c == '=' && i >= n - 2) break;
            else throw new IllegalArgumentException("not base64url");
            buf = (buf << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (byte) (buf >> bits);
            }
        }
        if (n % 4 == 1) throw new IllegalArgumentException("not base64url");
        byte[] trimmed = new byte[o];
        System.arraycopy(out, 0, trimmed, 0, o);
        return trimmed;
    }
}
