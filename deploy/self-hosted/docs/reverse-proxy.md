# Put Notato on the internet with HTTPS

By default Notato listens on `127.0.0.1:4799` only. To use it from other machines, phones or your team, put a reverse proxy with a TLS certificate in front. Without HTTPS, sign-in cookies cannot be marked `Secure`, and passwords and tokens cross the network in the clear.

## What Notato needs from the proxy

- `NOTATO_PUBLIC_URL=https://notato.example.com` in `.env`: the address people type. It is used for cookies, links in emails and origin checks.
- `NOTATO_TRUST_PROXY=1` in `.env`, **only** when a proxy you control is the sole way in. Notato then believes the proxy's `X-Forwarded-For` and `X-Forwarded-Proto` headers.
- The proxy must forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto: https`.
- Uploads up to about 40 MB (a screenshot is at most 32 MiB) and responses that are not buffered, so that MCP over HTTP can stream.
- Direct access to port 4799 closed to everyone but the proxy. The Compose file already binds it to loopback.

## Caddy (simplest)

Caddy gets and renews a Let's Encrypt certificate by itself. Point your domain's DNS at the machine, open ports 80 and 443, add two lines to `.env`:

```sh
NOTATO_DOMAIN=notato.example.com
NOTATO_PUBLIC_URL=https://notato.example.com
```

and start with the Caddy file added:

```sh
docker compose -f compose.yml -f examples/compose.caddy.yml --env-file .env up -d
```

It also stops publishing Notato on the host, so Caddy is the only way in, and turns on `NOTATO_TRUST_PROXY`. It needs Docker Compose 2.24 or later. The proxy settings are in [`examples/Caddyfile`](../examples/Caddyfile).

## nginx on the host

If nginx already runs on the host, use [`examples/nginx.conf`](../examples/nginx.conf) (its syntax is checked, and it expects certbot's certificate paths), set the two variables above, and keep Notato published on loopback as it is.

## Cloudflare Tunnel

A tunnel needs no open ports and no certificate on your side. Create a tunnel in the Cloudflare Zero Trust dashboard, give it a public hostname whose service is `http://server:4799`, and put its token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, with `NOTATO_PUBLIC_URL` set to that hostname:

```sh
docker compose -f compose.yml -f examples/compose.tunnel.yml --env-file .env up -d
```

[`examples/compose.tunnel.yml`](../examples/compose.tunnel.yml) also stops publishing Notato on the host and turns on `NOTATO_TRUST_PROXY`. Treat the token as a secret and keep it out of Git. This recipe follows Cloudflare's documented connector command but is not covered by this repository's tests; pin the image to a version you have checked.

## Any other proxy

Traefik, HAProxy, a cloud load balancer: anything that terminates TLS and meets the list at the top works. If sign-in succeeds but you are sent back to the login page, or links in emails use `http://`, the proxy is not sending `X-Forwarded-Proto`, or `NOTATO_PUBLIC_URL` does not match the address in the browser.
