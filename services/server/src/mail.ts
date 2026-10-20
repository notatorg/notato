import nodemailer from "nodemailer";
import { z } from "zod";

export interface Mailer {
    send(message: { to: string; subject: string; text: string }): Promise<void>;
}
/** Standard SMTP works with a local inbox, a private mail server or a hosted email provider. */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer {
    const host = env.NOTATO_SMTP_HOST;
    const from = env.NOTATO_EMAIL_FROM;
    if (!host || !from)
        throw new Error(
            "Set NOTATO_SMTP_HOST and NOTATO_EMAIL_FROM (a local SMTP inbox is supported)"
        );
    if (/[\r\n]/.test(from) || !z.email().safeParse(/<([^<>]+)>$/.exec(from)?.[1] ?? from).success)
        throw new Error("NOTATO_EMAIL_FROM must be a valid sender address");
    const port = Number(env.NOTATO_SMTP_PORT ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SMTP port");
    const secure = env.NOTATO_SMTP_SECURE ?? (port === 465 ? "true" : "false");
    if (!["true", "false"].includes(secure))
        throw new Error("NOTATO_SMTP_SECURE must be true or false");
    if (Boolean(env.NOTATO_SMTP_USER) !== Boolean(env.NOTATO_SMTP_PASSWORD))
        throw new Error("Set both NOTATO_SMTP_USER and NOTATO_SMTP_PASSWORD, or neither");
    const transport = nodemailer.createTransport({
        host,
        port,
        secure: secure === "true",
        ...(env.NOTATO_SMTP_USER
            ? { auth: { user: env.NOTATO_SMTP_USER, pass: env.NOTATO_SMTP_PASSWORD } }
            : {}),
        connectionTimeout: 10_000,
        socketTimeout: 30_000,
        disableFileAccess: true,
        disableUrlAccess: true,
    });
    return {
        async send(message) {
            await transport.sendMail({ ...message, from });
        },
    };
}
