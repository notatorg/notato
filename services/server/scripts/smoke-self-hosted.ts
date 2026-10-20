import { parseArgs } from "node:util";
import { type Annotation, sampleAnnotation } from "@notato/schema";
import { readDeploymentEnv } from "../../cli/src/preflight.ts";

/** Acceptance checks for a disposable Compose instance. No credentials or message contents are printed. */
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        env: { type: "string" },
        "mailpit-url": { type: "string", default: "http://localhost:8026" },
    },
});
if (!values.env) throw new Error("Pass --env with the disposable stack's private environment file");
const env = readDeploymentEnv(values.env);
const base = env.NOTATO_PUBLIC_URL ?? "http://localhost:4799";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
    throw new Error("This acceptance check requires a disposable local instance");
let cookie = "";
const call = async (path: string, method = "GET", body?: unknown, accepted = 200) => {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(cookie ? { cookie } : {}),
            Origin: base,
            "X-Notato-Board": "1",
            ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined
            ? {}
            : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    if (res.status !== accepted)
        throw new Error(
            `${method} ${path.split("?")[0]} returned ${res.status}, expected ${accepted}`
        );
    const cookies = res.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((item) => item.split(";")[0]).join("; ");
    return res;
};
await call("/ready");
await call("/api/auth/sign-in/email", "POST", {
    email: env.NOTATO_ADMIN_EMAIL,
    password: env.NOTATO_ADMIN_PASSWORD,
});
const me = (await (await call("/auth/me")).json()) as { instanceAdmin: boolean };
if (!me.instanceAdmin) throw new Error("Administrator session was not recognized");
const users = (await (await call("/instance/users")).json()) as {
    items: Array<{ protected: boolean }>;
};
if (!users.items.some((user) => user.protected))
    throw new Error("The protected administrator was not identified");
const made = (await (
    await call("/projects", "POST", { name: `Acceptance ${Date.now()}` }, 201)
).json()) as { project: { id: string } };
try {
    const bytes = Uint8Array.from(
        atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        ),
        (value) => value.charCodeAt(0)
    );
    const placeholder = "1".repeat(64);
    const annotation: Annotation = {
        ...sampleAnnotation,
        id: crypto.randomUUID(),
        projectId: made.project.id,
        mode: "test",
        createdAt: new Date().toISOString(),
        thread: [],
        screenshots: { full: { id: placeholder, mime: "image/png", w: 1, h: 1 } },
    };
    const form = new FormData();
    form.set("annotation", JSON.stringify(annotation));
    form.set(`asset:${placeholder}`, new File([bytes], "capture.png", { type: "image/png" }));
    const stored = (await (
        await call(`/projects/${made.project.id}/annotations`, "POST", form, 201)
    ).json()) as { annotation: Annotation };
    const id = stored.annotation.screenshots?.full?.id;
    if (!id || id === placeholder) throw new Error("Screenshot was not stored by content hash");
    const image = await (await call(`/assets/${id}`)).arrayBuffer();
    if (!Buffer.from(image).equals(Buffer.from(bytes)))
        throw new Error("S3 screenshot round-trip changed the image");
    const denied = await fetch(`${base}/assets/${id}`);
    if (denied.status !== 401) throw new Error("Anonymous screenshot access was not denied");
    const plugins = (await (await call("/plugins")).json()) as {
        configured: boolean;
        limits: { workflows: number };
        catalog: Array<{ id: string }>;
    };
    if (
        !plugins.configured ||
        plugins.limits.workflows < 1000 ||
        !plugins.catalog.some((item) => item.id === "github")
    )
        throw new Error("Self-hosted integrations were not fully enabled");
    const recipient = `acceptance-${crypto.randomUUID()}@example.test`;
    await call("/instance/invitations", "POST", { email: recipient }, 201);
    const messages = (await (await fetch(`${values["mailpit-url"]}/api/v1/messages`)).json()) as {
        messages: Array<{ To: Array<{ Address: string }> }>;
    };
    if (!messages.messages.some((message) => message.To.some((to) => to.Address === recipient)))
        throw new Error("SMTP invitation did not reach the mock inbox");
    console.log(
        "Passed: real Postgres login, admin access, project creation, private S3 image round-trip, unrestricted integrations and SMTP invitation delivery."
    );
} finally {
    await call(`/projects/${made.project.id}`, "DELETE", undefined, 204);
}
