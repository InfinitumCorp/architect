package com.infinitum.conductor;

import java.net.URI;

/** Only HTTPS origins are accepted. Tokens, paths and credentials never enter saved URLs. */
public final class ServerAddress {
    private ServerAddress() {}
    public static String normalize(String value) {
        try {
            URI uri = new URI(value.trim());
            String path = uri.getRawPath();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || (path != null && !path.isEmpty() && !"/".equals(path))
                    || uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException();
            return new URI("https", null, uri.getHost().toLowerCase(java.util.Locale.ROOT), uri.getPort(), "/", null, null).toASCIIString();
        } catch (Exception e) {
            throw new IllegalArgumentException("Enter an HTTPS server origin, for example https://conductor.example.com");
        }
    }
    public static boolean sameOrigin(String base, String target) {
        try {
            URI a = URI.create(base), b = URI.create(target);
            int ap = a.getPort() == -1 ? 443 : a.getPort(), bp = b.getPort() == -1 ? 443 : b.getPort();
            return "https".equalsIgnoreCase(b.getScheme()) && b.getRawUserInfo() == null && a.getHost().equalsIgnoreCase(b.getHost()) && ap == bp;
        } catch (Exception e) { return false; }
    }
}
