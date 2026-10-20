# Use your own screenshot storage

Screenshots live in a private S3-compatible bucket. Postgres holds the notes; the bucket holds the images. The bundled SeaweedFS needs nothing from you. To use something else (AWS S3, Cloudflare R2, Backblaze B2, a store you already run), remove `storage` from `COMPOSE_PROFILES` and set the `NOTATO_S3_*` settings below.

## What the bucket must be

- **Private.** Never enable anonymous or public access. Notato checks each screenshot request against the project's permissions and serves the bytes itself.
- **Created in advance.** Notato checks that the bucket exists when it starts (and stops with an error if it does not); it does not create it.
- **Reachable with a key that can** list the bucket and get, put and delete objects. An AWS policy for a bucket named `notato-screenshots`:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::notato-screenshots" },
      { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::notato-screenshots/*" }
    ]
  }
  ```

- **Left alone.** Objects are named by the SHA-256 of their content and removed by Notato. Do not add lifecycle rules that expire them, and no CORS configuration is needed.

## Settings

| Setting | Meaning |
| --- | --- |
| `NOTATO_S3_BUCKET` | The bucket name (default `screenshots`) |
| `NOTATO_S3_ENDPOINT` | The service's endpoint URL. Leave it out for AWS S3 |
| `NOTATO_S3_REGION` | The region (default `us-east-1`); `auto` for R2 |
| `NOTATO_S3_ACCESS_KEY_ID`, `NOTATO_S3_SECRET_ACCESS_KEY` | The key pair. Set both or neither |
| `NOTATO_S3_FORCE_PATH_STYLE` | `true` for stores that address buckets as `host/bucket` rather than `bucket.host` (most self-hosted stores) |
| `NOTATO_BLOB_CACHE_MB` | Verified in-memory cache, 0 to 128 (default 16) |

## Recipes

Hostnames change; check your provider's current documentation for them. The shapes are these.

**AWS S3**

```sh
COMPOSE_PROFILES=db,mail
NOTATO_S3_BUCKET=notato-screenshots
NOTATO_S3_REGION=eu-west-2
NOTATO_S3_ACCESS_KEY_ID=AKIA...
NOTATO_S3_SECRET_ACCESS_KEY=...
```

Use an IAM user whose policy is the one above. On AWS compute (EC2, ECS) you can leave both keys out and use the instance or task role instead.

**Cloudflare R2**

```sh
COMPOSE_PROFILES=db,mail
NOTATO_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
NOTATO_S3_REGION=auto
NOTATO_S3_BUCKET=notato-screenshots
NOTATO_S3_ACCESS_KEY_ID=...
NOTATO_S3_SECRET_ACCESS_KEY=...
```

Create an R2 API token with **Object Read & Write** limited to that bucket. Leave the bucket's public access off.

**Backblaze B2**

```sh
NOTATO_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
NOTATO_S3_REGION=<region>
NOTATO_S3_ACCESS_KEY_ID=<application key ID>
NOTATO_S3_SECRET_ACCESS_KEY=<application key>
```

**A store you run yourself** (SeaweedFS, Garage, Ceph RGW)

```sh
NOTATO_S3_ENDPOINT=http://my-store:8333
NOTATO_S3_FORCE_PATH_STYLE=true
NOTATO_S3_ACCESS_KEY_ID=...
NOTATO_S3_SECRET_ACCESS_KEY=...
```

If the store runs in Docker on this host, join its network with [`examples/compose.existing-network.yml`](../examples/compose.existing-network.yml) and use the container's name as the host. At the time of writing MinIO no longer publishes its community images to Docker Hub or Quay, so if you are choosing a store, prefer one of the others.

## Moving from the bundled storage

Object names are content hashes, so a plain copy is enough. Stop the server, then copy the bucket with any S3 tool, for example `rclone sync` or `aws s3 sync`, from the bundled store (add a temporary port mapping to the `objects` service, or run the tool in a container on the Compose network) to the new bucket. Start Notato with the new settings and open a note with a screenshot to confirm.

## Backups

Back the bucket up with your provider's tools (versioning, replication or `rclone`) together with the Postgres dump: the dump holds the notes, the bucket holds the images they point at. See [Backups and recovery](../README.md#backups-and-recovery).
