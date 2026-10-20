# Send real email

Notato sends invitations, address verification and password-reset messages over standard SMTP. The bundled Mailpit is a mock inbox: it catches every message and sends none. To email real people, point Notato at an SMTP server and remove `mail` from `COMPOSE_PROFILES`.

```sh
COMPOSE_PROFILES=db,storage
NOTATO_SMTP_HOST=smtp.example.com
NOTATO_SMTP_PORT=587
NOTATO_SMTP_USER=...
NOTATO_SMTP_PASSWORD=...
NOTATO_EMAIL_FROM=Notato <notato@example.com>
```

| Setting | Meaning |
| --- | --- |
| `NOTATO_SMTP_HOST`, `NOTATO_SMTP_PORT` | The server (default port 587) |
| `NOTATO_SMTP_SECURE` | `true` for implicit TLS (port 465, which is also the default there). With `false`, Notato upgrades the connection with STARTTLS when the server offers it |
| `NOTATO_SMTP_USER`, `NOTATO_SMTP_PASSWORD` | Set both or neither |
| `NOTATO_EMAIL_FROM` | The sender: `address@example.com` or `Name <address@example.com>`. The provider must allow it |

## Providers

Check your provider's current documentation for hostnames and limits. The usual shapes:

| Provider | Host | Port | User | Password |
| --- | --- | --- | --- | --- |
| Resend | `smtp.resend.com` | 465 (`NOTATO_SMTP_SECURE=true`) or 587 | `resend` | An API key |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SMTP credentials (not your IAM keys) | SMTP password |
| Postmark | `smtp.postmarkapp.com` | 587 | A server API token | The same token |
| Mailgun | `smtp.mailgun.org` | 587 | A domain SMTP login | Its password |
| Fastmail, Gmail, Microsoft 365 | Their SMTP hosts | 465 or 587 | Your address | An **app password**, not your account password |
| Your own Postfix or relay | Its address | 25 or 587 | Optional | Optional |

Providers only send from addresses and domains you have verified with them. Set up SPF, DKIM and DMARC for the sending domain as they describe, or invitations will land in spam.

## Check it works

Under **Instance → Invitations**, invite an address you control. The message should arrive within seconds. The server logs say why when it does not: `docker compose logs server`.

## Running without real email

Invitations, address verification for public sign-up and **Forgot password** all need email. For a one-person instance you can keep the bundled Mailpit and read the links yourself at `http://localhost:8026`; it listens on this machine only. You can still change your own password under **Settings → Account → Password**. Once other people use the instance, switch to real email.
