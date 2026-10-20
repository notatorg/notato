/**
 * A blank setting means "not set". Docker Compose passes every setting it lists as a string, so an optional one the
 * operator left out arrives as "" and would otherwise count as a (wrong) value, such as an empty SMTP_SECURE.
 */
export function dropBlankSettings<T extends Record<string, string | undefined>>(env: T): T {
    for (const [key, value] of Object.entries(env))
        if (key.startsWith("NOTATO_") && value?.trim() === "") delete env[key];
    return env;
}

/** Plain-language help for the start-up failures a new operator meets most. */
export function explainStartupError(message: string): string {
    if (/does not support SSL/i.test(message))
        return `${message}. The database has no TLS, and connections to it verify TLS by default. If it is on a private network you trust, set NOTATO_DATABASE_SSL=disable; otherwise turn TLS on in Postgres.`;
    if (
        /self[- ]signed certificate|unable to verify the first certificate|certificate/i.test(
            message
        ) &&
        /ssl|tls|cert/i.test(message)
    )
        return `${message}. If your database uses a private certificate authority, set NOTATO_DATABASE_CA_FILE to its certificate.`;
    return message;
}
