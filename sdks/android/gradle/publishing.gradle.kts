// Maven publishing for both libraries, from gradle.properties: the coordinates, the POM Maven Central asks for, and a
// signature when a key is given (ORG_GRADLE_PROJECT_signingInMemoryKey and ORG_GRADLE_PROJECT_signingInMemoryKeyPassword).
//
//   ./gradlew publishToMavenLocal                        apps on this machine take it from mavenLocal()
//   ./gradlew publishAllPublicationsToStagingRepository   writes build/staging-deploy: the bundle for Maven Central
import org.gradle.api.publish.PublishingExtension
import org.gradle.api.publish.maven.MavenPublication
import org.gradle.plugins.signing.SigningExtension

apply(plugin = "maven-publish")
apply(plugin = "signing")

/** From this module's gradle.properties (its artifact) or the root one (everything shared). */
fun prop(name: String): String = findProperty(name)?.toString() ?: error("$name is not set in gradle.properties")

afterEvaluate {
    val publishing = extensions.getByType(PublishingExtension::class.java)
    publishing.publications.register("release", MavenPublication::class.java) {
        groupId = prop("GROUP")
        artifactId = prop("POM_ARTIFACT_ID")
        version = prop("VERSION_NAME")
        from(components.getByName("release"))
        pom {
            name.set(prop("POM_NAME"))
            description.set(prop("POM_DESCRIPTION"))
            url.set(prop("POM_URL"))
            licenses {
                license {
                    name.set(prop("POM_LICENSE_NAME"))
                    url.set(prop("POM_LICENSE_URL"))
                }
            }
            developers {
                developer {
                    id.set(prop("POM_DEVELOPER_ID"))
                    name.set(prop("POM_DEVELOPER_NAME"))
                    url.set(prop("POM_DEVELOPER_URL"))
                }
            }
            scm {
                url.set(prop("POM_SCM_URL"))
                connection.set(prop("POM_SCM_CONNECTION"))
                developerConnection.set(prop("POM_SCM_DEV_CONNECTION"))
            }
        }
    }
    publishing.repositories.maven {
        name = "staging"
        url = rootProject.layout.buildDirectory.dir("staging-deploy").get().asFile.toURI()
    }
    val key = findProperty("signingInMemoryKey")?.toString()
    if (key != null) {
        extensions.configure(SigningExtension::class.java) {
            useInMemoryPgpKeys(key, findProperty("signingInMemoryKeyPassword")?.toString())
            sign(publishing.publications)
        }
    }
}
