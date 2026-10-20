import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resourceLimitsFromEnv, signupPolicyFromEnv } from "@notato/service-server";
import { dropBlankSettings } from "./environment.ts";
export interface DeploymentCheck {
    id: string;
    status: "pass" | "fail" | "manual";
    detail: string;
}
export interface PreflightReport {
    profile: "self-hosted";
    configurationValid: boolean;
    liveChecksRequired: boolean;
    checks: DeploymentCheck[];
}
/** Offline validation never opens application data or prints setting values. */
export function inspectDeployment(
    env: Record<string, string | undefined>,
    profile: "self-hosted" = "self-hosted"
): PreflightReport {
    const checks: DeploymentCheck[] = [];
    const check = (id: string, valid: boolean, detail: string) =>
        checks.push({ id, status: valid ? "pass" : "fail", detail });
    let origin = false;
    try {
        const u = new URL(env.NOTATO_PUBLIC_URL ?? "");
        origin =
            !u.username &&
            !u.password &&
            u.pathname === "/" &&
            !u.search &&
            !u.hash &&
            (u.protocol === "https:" ||
                (u.protocol === "http:" &&
                    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
    } catch {}
    check("public-origin", origin, "Set NOTATO_PUBLIC_URL to an HTTPS origin, or HTTP on loopback");
    let database = false;
    try {
        database = ["postgres:", "postgresql:"].includes(
            new URL(env.NOTATO_DATABASE_URL ?? "").protocol
        );
    } catch {}
    check("database", database, "Set NOTATO_DATABASE_URL to a Postgres connection URL");
    check(
        "database-tls",
        !env.NOTATO_DATABASE_SSL || ["disable", "verify-full"].includes(env.NOTATO_DATABASE_SSL),
        "NOTATO_DATABASE_SSL supports disable (private networks) or verify-full"
    );
    check(
        "identity",
        (env.NOTATO_AUTH_SECRET?.length ?? 0) >= 32,
        "NOTATO_AUTH_SECRET needs at least 32 random characters"
    );
    check(
        "administrator",
        Boolean(
            env.NOTATO_ADMIN_EMAIL?.includes("@") && (env.NOTATO_ADMIN_PASSWORD?.length ?? 0) >= 12
        ),
        "Set NOTATO_ADMIN_EMAIL and a password of at least 12 characters for first startup"
    );
    let signup = false;
    try {
        signupPolicyFromEnv(env);
        signup = true;
    } catch {}
    let capacity = false;
    try {
        resourceLimitsFromEnv(env);
        capacity = true;
    } catch {}
    check(
        "resource-limits",
        capacity,
        "NOTATO_RESOURCE_LIMITS is optional JSON capacity configuration"
    );
    check(
        "signup-policy",
        signup,
        "Registration defaults to closed; NOTATO_SIGNUP_MODE can be closed, allowlist or open"
    );
    check(
        "storage",
        Boolean(env.NOTATO_S3_BUCKET),
        "Set NOTATO_S3_BUCKET; endpoint, region and credentials are configurable"
    );
    check(
        "storage-credentials",
        Boolean(env.NOTATO_S3_ACCESS_KEY_ID) === Boolean(env.NOTATO_S3_SECRET_ACCESS_KEY),
        "Supply both S3 credentials or use the standard AWS credential chain"
    );
    check(
        "email",
        Boolean(env.NOTATO_SMTP_HOST && env.NOTATO_EMAIL_FROM),
        "Set NOTATO_SMTP_HOST and NOTATO_EMAIL_FROM; a local SMTP inbox is supported"
    );
    check(
        "email-credentials",
        Boolean(env.NOTATO_SMTP_USER) === Boolean(env.NOTATO_SMTP_PASSWORD),
        "Supply both SMTP credentials, or neither for an unauthenticated relay"
    );
    check(
        "integrations",
        /^[a-fA-F0-9]{64}$/.test(env.NOTATO_PLUGIN_KEY ?? ""),
        "Set NOTATO_PLUGIN_KEY to 64 random hex characters to encrypt integration credentials"
    );
    checks.push({
        id: "operations",
        status: "manual",
        detail: "Verify login, email, private object access, and a restore of Postgres and object storage",
    });
    return {
        profile,
        configurationValid: !checks.some((c) => c.status === "fail"),
        liveChecksRequired: true,
        checks,
    };
}

/** Private dotenv file, parsed as data. No shell execution, substitutions, environment changes or secret output. */
export function readDeploymentEnv(path: string): Record<string, string> {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 65536)
            throw new Error("deployment environment must be a regular file smaller than 64 KiB");
        if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
            throw new Error(
                "deployment environment must have private file permissions; run chmod 600 on it"
            );
        const env: Record<string, string> = Object.create(null);
        for (const [index, line] of readFileSync(fd, "utf8").split(/\r?\n/).entries()) {
            const text = line.trim();
            if (!text || text.startsWith("#")) continue;
            const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(text);
            if (!match) throw new Error(`invalid environment assignment on line ${index + 1}`);
            const key = match[1] ?? "",
                raw = match[2] ?? "";
            if (Object.hasOwn(env, key))
                throw new Error(`duplicate environment assignment on line ${index + 1}`);
            let value = raw;
            if (raw.startsWith('"') || raw.startsWith("'")) {
                const quote = raw[0];
                const end = raw.lastIndexOf(quote ?? "");
                if (end === 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1)))
                    throw new Error(`invalid quoted environment value on line ${index + 1}`);
                value = raw.slice(1, end);
            } else value = raw.replace(/\s+#.*$/, "").trimEnd();
            if (/\$\(|`|\$\{/.test(value))
                throw new Error(
                    `environment expansion is not supported on line ${index + 1}; use resolved literal values`
                );
            env[key] = value;
        }
        return dropBlankSettings(env);
    } finally {
        closeSync(fd);
    }
}
export async function runPreflightCommand(argv: string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            env: { type: "string" },
            profile: { type: "string", default: "self-hosted" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help) {
        console.log(
            "notato preflight [--env /private/service.env] [--profile self-hosted] [--json]\nOffline configuration checks only. Does not contact external services, change the service, or print secrets.\nUse resolved service settings; Compose-injected settings require manual verification."
        );
        return 0;
    }
    if (!["self-hosted"].includes(values.profile ?? ""))
        throw new Error("preflight profile must be self-hosted");
    const report = inspectDeployment(
        values.env ? readDeploymentEnv(values.env) : process.env,
        values.profile as "self-hosted"
    );
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`Notato ${report.profile} configuration preflight`);
        for (const c of report.checks)
            console.log(
                `${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "!"} ${c.id}: ${c.detail}`
            );
        console.log(
            report.configurationValid
                ? "Configuration checks passed; live deployment checks are still required."
                : "Configuration is incomplete; resolve failed checks before activation."
        );
    }
    return report.configurationValid ? 0 : 1;
}
