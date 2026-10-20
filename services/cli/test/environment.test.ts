import { expect, it } from "bun:test";
import { dropBlankSettings, explainStartupError } from "../src/environment.ts";

it("treats a blank Notato setting as unset and leaves everything else alone", () => {
    const env: Record<string, string | undefined> = {
        NOTATO_SMTP_SECURE: "",
        NOTATO_S3_ENDPOINT: "  ",
        NOTATO_SMTP_HOST: "smtp.example.com",
        NOTATO_SIGNUP_ALLOWED_EMAILS: "a@example.com",
        HTTP_PROXY: "",
    };
    dropBlankSettings(env);
    expect(Object.keys(env).sort()).toEqual([
        "HTTP_PROXY",
        "NOTATO_SIGNUP_ALLOWED_EMAILS",
        "NOTATO_SMTP_HOST",
    ]);
});

it("explains a database without TLS and a private certificate authority, and leaves other errors alone", () => {
    expect(explainStartupError("The server does not support SSL connections")).toContain(
        "NOTATO_DATABASE_SSL=disable"
    );
    expect(explainStartupError("self-signed certificate in certificate chain")).toContain(
        "NOTATO_DATABASE_CA_FILE"
    );
    expect(explainStartupError("password authentication failed")).toBe(
        "password authentication failed"
    );
});
