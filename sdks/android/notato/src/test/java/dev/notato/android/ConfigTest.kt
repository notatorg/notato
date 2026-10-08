package dev.notato.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The configuration: loose values read, what cannot work explained, and the token kept to its server. */
class ConfigTest {
    @Test
    fun readsLooseValuesWhateverTheirCase() {
        val config = NotatoConfig.from(
            mapOf(
                "project" to "shop", "MODE" to "Test", "server" to "https://notato.example.com/", "token" to "notato_abc",
                "Show_Toolbar" to "false", "toolbar-position" to "top_start", "maskInputs" to true, "logLimit" to "20",
                "screenshots" to "off", "shakeToToggle" to "no",
            ),
        )!!
        assertEquals("shop", config.project)
        assertEquals(NotatoMode.TEST, config.mode)
        assertEquals("https://notato.example.com", config.resolvedServer)
        assertEquals("notato_abc", config.token)
        assertFalse(config.showToolbar)
        assertEquals(ToolbarCorner.TOP_START, config.toolbarPosition)
        assertEquals(true, config.maskInputs)
        assertEquals(20, config.logLimit)
        assertFalse(config.screenshots)
        assertFalse(config.shakeToToggle)
        assertNull(config.problem)
    }

    @Test
    fun noProjectMeansNoConfiguration() {
        assertNull(NotatoConfig.from(mapOf("mode" to "dev")))
        assertNull(NotatoConfig.from(mapOf("project" to "  ")))
    }

    @Test
    fun theServerDependsOnTheMode() {
        assertEquals(NotatoConfig.DEFAULT_SERVER, NotatoConfig("shop").resolvedServer)
        assertEquals(NotatoConfig.DEFAULT_SERVER, NotatoConfig("shop", mode = NotatoMode.AGENT).resolvedServer)
        assertNull(NotatoConfig("shop", mode = NotatoMode.TEST).resolvedServer)
        assertNull(NotatoConfig("shop", noServer = true).resolvedServer)
        // An empty server value turns the server off, even in dev mode.
        assertNull(NotatoConfig.from(mapOf("project" to "shop", "server" to ""))!!.resolvedServer)
    }

    @Test
    fun inputsAreMaskedOutsideDevMode() {
        assertFalse(NotatoConfig("shop").resolvedMaskInputs)
        assertTrue(NotatoConfig("shop", mode = NotatoMode.TEST).resolvedMaskInputs)
        assertFalse(NotatoConfig("shop", mode = NotatoMode.TEST, maskInputs = false).resolvedMaskInputs)
    }

    @Test
    fun explainsAConfigurationThatCannotWork() {
        assertTrue(NotatoConfig("my shop").problem!!.contains("letters, digits"))
        assertTrue(NotatoConfig("shop", server = "localhost:4747").problem!!.contains("not an http(s) URL"))
        assertTrue(NotatoConfig("shop", maxScreenshotScale = 8.0).problem!!.contains("maxScreenshotScale"))
        // Only dots would name a parent folder; the server refuses them too, and letters it does not take.
        for (project in listOf(".", "..", "...", "café")) assertTrue(project, NotatoConfig(project).problem!!.contains("letters, digits"))
        assertNull(NotatoConfig("shop.v2@acme_1-x").problem)
        assertTrue(NotatoConfig("shop", server = "http://localhost:47o7").problem!!.contains("port that is not a number"))
    }

    @Test
    fun aServerAddressMustBeAUrlItCanReach() {
        for (good in listOf("http://localhost:4747", "https://notato.example.com", "https://example.com/notato", "http://10.0.2.2:4790", "http://[::1]:4747")) {
            assertNull(good, NotatoConfig.serverProblem(good))
        }
        assertEquals("has a port that is not a number", NotatoConfig.serverProblem("http://localhost:47o7"))
        assertEquals("has a port outside 1 to 65535", NotatoConfig.serverProblem("http://localhost:99999"))
        assertEquals("is not an http(s) URL", NotatoConfig.serverProblem("localhost:4747"))
        assertEquals("is not an http(s) URL", NotatoConfig.serverProblem("ftp://example.com"))
        assertEquals("has no host", NotatoConfig.serverProblem("http:///projects"))
        assertEquals("is not a valid URL", NotatoConfig.serverProblem("http://local host:4747"))
        assertEquals("has a query or fragment; give only the server's address", NotatoConfig.serverProblem("http://localhost:4747?x=1"))
    }

    @Test
    fun theTokenGoesOnlyToTheConfiguredServer() {
        val config = NotatoConfig("shop", server = "https://notato.example.com/team", token = " notato_abc ")
        // The same scheme, host and port, whatever the path, the host's case or a trailing slash.
        for (same in listOf("https://notato.example.com/team", "https://NOTATO.example.com/", "https://notato.example.com:443", "https://notato.example.com/other")) {
            assertEquals(same, "notato_abc", config.tokenFor(same))
        }
        // A server typed into the Settings sheet: another host, scheme or port never gets it.
        for (other in listOf("https://evil.example.com", "http://notato.example.com", "https://notato.example.com:8443", "https://notato.example.com.evil.net", "not a url")) {
            assertNull(other, config.tokenFor(other))
        }
        assertNull(NotatoConfig("shop", server = "https://notato.example.com").tokenFor("https://notato.example.com"))
        // The default server, with no port written, is the same as one with it.
        assertEquals("notato_abc", NotatoConfig("shop", token = "notato_abc").tokenFor("http://LOCALHOST:4747/"))
        assertTrue(NotatoConfig.sameServer("http://example.com", "http://example.com:80"))
        assertFalse(NotatoConfig.sameServer("http://example.com", "https://example.com:80"))
    }
}
