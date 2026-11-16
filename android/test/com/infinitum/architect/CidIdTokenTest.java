package com.infinitum.architect;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/** Plain-JVM tests for the on-device ID token check (run with android/test.sh). */
public class CidIdTokenTest {
    private static final String CERTS = "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs";
    private static final String MIRROR_CERTS = "https://ru.id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs";
    private static final long NOW = 1_800_000_000_000L;

    private KeyPair key;
    private KeyPair other;
    private String jwks;
    private final List<String> fetched = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        key = g.generateKeyPair();
        other = g.generateKeyPair();
        jwks = jwks(jwk(key, "k1"));
    }

    private static String b64(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static byte[] fixed(BigInteger v) {
        byte[] b = v.toByteArray();
        byte[] out = new byte[32];
        int n = Math.min(32, b.length);
        System.arraycopy(b, b.length - n, out, 32 - n, n);
        return out;
    }

    private static JSONObject jwk(KeyPair kp, String kid) throws Exception {
        ECPublicKey pub = (ECPublicKey) kp.getPublic();
        return new JSONObject().put("kty", "EC").put("crv", "P-256").put("use", "sig").put("alg", "ES256").put("kid", kid)
            .put("x", b64(fixed(pub.getW().getAffineX()))).put("y", b64(fixed(pub.getW().getAffineY())));
    }

    private static String jwks(JSONObject... keys) throws Exception {
        JSONArray a = new JSONArray();
        for (JSONObject k : keys) a.put(k);
        return new JSONObject().put("keys", a).toString();
    }

    /** DER ECDSA signature to JOSE r||s (what the issuer sends). */
    private static byte[] derToJose(byte[] der) {
        int off = 2;
        int rLen = der[off + 1];
        BigInteger r = new BigInteger(1, java.util.Arrays.copyOfRange(der, off + 2, off + 2 + rLen));
        off = off + 2 + rLen;
        int sLen = der[off + 1];
        BigInteger s = new BigInteger(1, java.util.Arrays.copyOfRange(der, off + 2, off + 2 + sLen));
        byte[] out = new byte[64];
        System.arraycopy(fixed(r), 0, out, 0, 32);
        System.arraycopy(fixed(s), 0, out, 32, 32);
        return out;
    }

    private static String sign(KeyPair kp, JSONObject header, JSONObject claims) throws Exception {
        String input = b64(header.toString().getBytes(StandardCharsets.UTF_8)) + "." + b64(claims.toString().getBytes(StandardCharsets.UTF_8));
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(kp.getPrivate());
        s.update(input.getBytes(StandardCharsets.US_ASCII));
        return input + "." + b64(derToJose(s.sign()));
    }

    private static JSONObject header(String kid) throws Exception {
        return new JSONObject().put("alg", "ES256").put("typ", "JWT").put("kid", kid);
    }

    private static JSONObject claims() throws Exception {
        long now = NOW / 1000;
        return new JSONObject()
            .put("iss", CidIdToken.ISSUER).put("aud", "architect").put("sub", "cid_7c1e")
            .put("exp", now + 300).put("iat", now).put("nonce", "n-123")
            .put("name", "Ann").put("preferred_username", "ann").put("email", "ann@cumuluscloud.app").put("handle", "@ann");
    }

    private CidIdToken verifier() {
        return new CidIdToken(CidIdToken.ISSUER, "architect", url -> {
            fetched.add(url);
            return jwks;
        }, () -> NOW);
    }

    private void rejects(CidIdToken v, String token, String nonce) {
        try {
            v.verify(token, nonce, CERTS);
            fail("accepted a token it should reject: " + token);
        } catch (CidIdToken.Invalid expected) {
            // ok
        }
    }

    @Test
    public void acceptsAValidToken() throws Exception {
        JSONObject c = verifier().verify(sign(key, header("k1"), claims()), "n-123", CERTS);
        assertEquals("cid_7c1e", c.getString("sub"));
        assertEquals("ann@cumuluscloud.app", c.getString("email"));
        assertEquals(List.of(CERTS), fetched);
    }

    @Test
    public void rejectsWrongIssuerAudienceNonceAndSubject() throws Exception {
        CidIdToken v = verifier();
        rejects(v, sign(key, header("k1"), claims().put("iss", "https://id.cumuluscloud.app")), "n-123");
        rejects(v, sign(key, header("k1"), claims().put("iss", "https://ru.id.cumuluscloud.app/realms/cumulus")), "n-123");
        rejects(v, sign(key, header("k1"), claims().put("aud", "fabric")), "n-123");
        rejects(v, sign(key, header("k1"), claims().put("aud", new JSONArray().put("architect").put("fabric"))), "n-123");
        v.verify(sign(key, header("k1"), claims().put("aud", new JSONArray().put("architect").put("fabric")).put("azp", "architect")), "n-123", CERTS);
        rejects(v, sign(key, header("k1"), claims()), "n-other");
        rejects(v, sign(key, header("k1"), claims()), "");
        rejects(v, sign(key, header("k1"), claims().put("nonce", "")), "");
        rejects(v, sign(key, header("k1"), claims().put("sub", "")), "n-123");
        JSONObject noSub = claims();
        noSub.remove("sub");
        rejects(v, sign(key, header("k1"), noSub), "n-123");
    }

    @Test
    public void expiryAllowsSixtySecondsOfSkew() throws Exception {
        long now = NOW / 1000;
        CidIdToken v = verifier();
        v.verify(sign(key, header("k1"), claims().put("exp", now - 59)), "n-123", CERTS);
        rejects(v, sign(key, header("k1"), claims().put("exp", now - 60)), "n-123");
        rejects(v, sign(key, header("k1"), claims().put("exp", now - 3600)), "n-123");
        JSONObject noExp = claims();
        noExp.remove("exp");
        rejects(v, sign(key, header("k1"), noExp), "n-123");
        rejects(v, sign(key, header("k1"), claims().put("iat", now + 3600)), "n-123");
    }

    @Test
    public void rejectsBadSignaturesAndOtherTokenKinds() throws Exception {
        CidIdToken v = verifier();
        String good = sign(key, header("k1"), claims());
        String[] p = good.split("\\.");
        String forged = p[0] + "." + b64(claims().put("sub", "cid_evil").toString().getBytes(StandardCharsets.UTF_8)) + "." + p[2];
        rejects(v, forged, "n-123");
        rejects(v, sign(other, header("k1"), claims()), "n-123");
        rejects(v, sign(key, header("k1").put("alg", "HS256"), claims()), "n-123");
        rejects(v, sign(key, header("k1").put("alg", "none"), claims()), "n-123");
        rejects(v, sign(key, header("k1").put("typ", "at+jwt"), claims()), "n-123");
        rejects(v, p[0] + "." + p[1] + ".", "n-123");
        rejects(v, p[0] + "." + p[1], "n-123");
        rejects(v, null, "n-123");
        rejects(v, "not.a.jwt", "n-123");
    }

    @Test
    public void cachesKeysAndRefetchesOnceForAnUnknownKid() throws Exception {
        CidIdToken v = verifier();
        v.verify(sign(key, header("k1"), claims()), "n-123", CERTS);
        v.verify(sign(key, header("k1"), claims()), "n-123", CERTS);
        assertEquals(1, fetched.size());
        // The issuer rotates to k2 and publishes it next to k1: one refetch, then it verifies.
        jwks = jwks(jwk(key, "k1"), jwk(other, "k2"));
        v.verify(sign(other, header("k2"), claims()), "n-123", CERTS);
        assertEquals(2, fetched.size());
        v.verify(sign(other, header("k2"), claims()), "n-123", CERTS);
        assertEquals(2, fetched.size());
        // A kid nobody publishes: one refetch per attempt, then it fails.
        rejects(v, sign(other, header("k9"), claims()), "n-123");
        assertEquals(3, fetched.size());
    }

    @Test
    public void mirrorKeysStillNeedTheCanonicalIssuer() throws Exception {
        CidIdToken v = verifier();
        v.verify(sign(key, header("k1"), claims()), "n-123", MIRROR_CERTS);
        assertEquals(List.of(MIRROR_CERTS), fetched);
        try {
            v.verify(sign(key, header("k1"), claims().put("iss", "https://ru.id.cumuluscloud.app/realms/cumulus")), "n-123", MIRROR_CERTS);
            fail("accepted the mirror as issuer");
        } catch (CidIdToken.Invalid expected) {
            assertEquals("wrong issuer", expected.getMessage());
        }
    }

    @Test
    public void keysThatAreNotP256SigningKeysAreIgnored() throws Exception {
        JSONObject k = jwk(key, "k1");
        jwks = jwks(new JSONObject(k.toString()).put("use", "enc"), new JSONObject(k.toString()).put("crv", "P-384"),
            new JSONObject(k.toString()).put("y", k.getString("x")));
        rejects(verifier(), sign(key, header("k1"), claims()), "n-123");
    }

    @Test
    public void unreachableJwksFailsClosed() throws Exception {
        CidIdToken v = new CidIdToken(CidIdToken.ISSUER, "architect", url -> {
            throw new IOException("offline");
        }, () -> NOW);
        rejects(v, sign(key, header("k1"), claims()), "n-123");
    }

    @Test
    public void joseToDerHandlesHighBitsAndLeadingZeros() {
        byte[] raw = new byte[64];
        raw[0] = (byte) 0x80; // r needs a 0x00 pad
        raw[31] = 1;
        raw[63] = 5; // s is a single byte after its leading zeros go
        byte[] der = CidIdToken.joseToDer(raw);
        assertEquals(0x30, der[0]);
        assertEquals(der.length - 2, der[1]);
        assertEquals(0x02, der[2]);
        assertEquals(33, der[3]);
        assertEquals(0, der[4]);
        assertEquals((byte) 0x80, der[5]);
        assertArrayEquals(new byte[] {0x02, 0x01, 0x05}, java.util.Arrays.copyOfRange(der, der.length - 3, der.length));
        assertTrue(der.length == 2 + 35 + 3);
    }

    @Test
    public void base64urlMatchesTheJdk() {
        for (int n = 0; n < 70; n++) {
            byte[] b = new byte[n];
            for (int i = 0; i < n; i++) b[i] = (byte) (i * 37 + n);
            assertArrayEquals(b, CidIdToken.b64urlDecode(b64(b)));
        }
    }
}
