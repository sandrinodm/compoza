import { Schema } from 'effect';

/**
 * A lowercase identifier of letters, digits and dashes: Compose project names, image name prefixes,
 * host keys and content section names, which all end up in file names, container names and image
 * references.
 */
export const Name = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/, {
      message: 'expected lowercase letters, digits and dashes, starting with a letter or digit',
    }),
  ),
);

/**
 * A Dockerfile build target: like `Name`, but underscores are allowed because Dockerfile stage
 * names may use them.
 */
export const Target = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/, {
      message:
        'expected lowercase letters, digits, dashes and underscores, ' +
        'starting with a letter or digit',
    }),
  ),
);

/**
 * An absolute path without whitespace, as host folders are: Compose resolves relative bind mounts
 * on the Docker host against a folder that does not exist there, so every host path has to be
 * absolute.
 */
export const AbsolutePath = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\/\S*$/, { message: 'expected an absolute path without whitespace' }),
  ),
);

/**
 * A public DNS name with at least one dot and an alphabetic top-level label.
 */
export const Domain = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, {
      message: 'expected a domain name such as app.example.com',
    }),
  ),
);

/**
 * A container name (or network alias) and port, `name:port`, as the proxy reaches the app over the
 * shared network.
 */
export const Upstream = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z0-9][a-z0-9_.-]*:\d+$/, { message: 'expected container:port' }),
  ),
);

/**
 * An SSH destination: `user@host`, or a bare host or `~/.ssh/config` alias such as `nas`. The same
 * string names the Docker endpoint `ssh://<destination>`.
 *
 * A bare alias leaves the user, port and key to the SSH config, which both `ssh` and Docker's SSH
 * transport read. Empty strings and whitespace are rejected, since the value is passed to `ssh` as
 * a single argument.
 */
export const SshDestination = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?:[\w.-]+@)?[\w.-]+$/, {
      message: 'expected user@host or an SSH config alias',
    }),
  ),
);

/**
 * A Compose service name, as the keys under `services:` are: letters, digits, dots, underscores and
 * dashes, starting with a letter or digit.
 *
 * This is the Compose specification's `^[a-zA-Z0-9._-]+$`, looser than `Name` so existing proxy
 * Compose files are accepted as they are, plus a leading letter or digit so the value never reads
 * as a flag to `docker compose up`.
 */
export const ComposeServiceName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, {
      message: 'expected a Compose service name',
    }),
  ),
);

/**
 * A dotted IPv4 address, which is what the app domains must resolve to.
 */
export const Ipv4 = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^(?:\d{1,3}\.){3}\d{1,3}$/, { message: 'expected an IPv4 address' }),
  ),
);

/**
 * A Docker build platform such as `linux/arm64` or `linux/amd64`.
 */
export const Platform = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^linux\/[\w/]+$/, { message: 'expected a platform such as linux/arm64' }),
  ),
);

/**
 * A registry host without a scheme, optionally with a port, as it appears at the front of an image
 * reference.
 */
export const Registry = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[\w.-]+(?::\d+)?$/, {
      message: 'expected a registry host such as registry.example.com',
    }),
  ),
);

/**
 * A Caddyfile snippet name as written between parentheses when it is defined, e.g. `request_log`.
 */
export const SnippetName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9][\w-]*$/, { message: 'expected a Caddy snippet name' }),
  ),
);

/**
 * A Docker network name.
 */
export const NetworkName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[\w.-]+$/, { message: 'expected a Docker network name' })),
);

/**
 * A URL path probed after a deploy: it starts with `/` and holds no whitespace.
 *
 * Deploy appends it directly after the domain, so `healthz` without the slash would turn into the
 * hostname `<domain>healthz` and a three-minute wait that ends in a false failure.
 */
export const HealthPath = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\/\S*$/, {
      message: 'expected a URL path starting with / and without whitespace',
    }),
  ),
);
