package com.infinitum.conductor;
import org.junit.Test;
import static org.junit.Assert.*;
public class ServerAddressTest {
 @Test public void normalizesHttpsOrigins() { assertEquals("https://example.com/",ServerAddress.normalize(" https://EXAMPLE.com ")); assertEquals("https://example.com:7443/",ServerAddress.normalize("https://example.com:7443/")); }
 @Test public void rejectsCredentialsAndUnsafeSchemes() { for(String value : new String[]{"http://example.com","javascript:alert(1)","file:///tmp/x","https://a:b@example.com","https://example.com/?token=secret","https://example.com/#runs","https://example.com/path","https://example.com:99999"}) { try { ServerAddress.normalize(value); fail(value); } catch(IllegalArgumentException expected) {} } }
 @Test public void confinesNavigationToExactOrigin() { assertTrue(ServerAddress.sameOrigin("https://example.com/","https://example.com:443/#scores")); assertFalse(ServerAddress.sameOrigin("https://example.com/","https://example.com.evil.test/")); assertFalse(ServerAddress.sameOrigin("https://example.com/","https://example.com:8443/")); assertFalse(ServerAddress.sameOrigin("https://example.com/","http://example.com/")); assertFalse(ServerAddress.sameOrigin("https://example.com/","https://user@example.com/")); }
}
