# Comparing deployment tools

[README](../README.md) · [Configuration](configuration.md) · [Ingress](ingress.md) · [SSH deployment](ssh-deployment.md)

compoza is a CLI for deploying existing Docker Compose stacks over SSH. Its focus is a repeatable workflow around your Compose files: build or select images, deliver them, resolve credentials, check readiness, configure ingress and operate the deployed stack. It has no central web application or deployment database to run.

That makes it useful when you want to own the Compose definitions and host setup and invoke deployments from a terminal, CI job or coding agent. You also own the surrounding operations: access management, monitoring, backups, scheduling and recovery from host failure.

This guide compares deployment models, operational responsibilities and trade-offs, with links to each tool's official documentation.

## At a glance

| Tool                                                                        | Main deployment model                                                                      | Consider it when                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **compoza**                                                                 | Compose files plus `deploy.json` and a separate host inventory; CLI operations over SSH    | You want explicit, scriptable deployments of existing stacks with selectable ingress and credential providers. |
| **[Kamal](https://kamal-deploy.org/docs/installation/)**                    | CLI-managed application containers, server configuration and proxy-coordinated replacement | Your priority is deploying application versions with a health-gated traffic switch.                            |
| **[Dokploy](https://docs.dokploy.com/docs/core/features)**                  | A management platform for applications, Compose stacks and databases                       | You want a dashboard that brings deployments, logs, monitoring and database operations together.               |
| **[Coolify](https://coolify.io/docs/core/what-is-coolify)**                 | A dashboard/API platform coordinating Docker workloads on connected servers                | You want a platform workflow for source deployments, services and infrastructure management.                   |
| **[Compose directly](https://docs.docker.com/compose/how-tos/production/)** | Docker's CLI runs your Compose definitions                                                 | Your deployment is small enough that a few documented commands or scripts cover it.                            |

Compose support, SSH access and external secrets are not exclusive to this project. The distinction is the workflow and responsibility each tool takes on.

## Compared with Kamal

Kamal is the closest comparison for a CLI-driven workflow. Its configuration describes application deployment rather than using a Compose project as the deployment unit. Its documented setup builds and distributes an image through a registry, starts a new application container, checks it through `kamal-proxy`, switches requests and then stops the old container. The default readiness check requires a successful `GET /up` response. See [Kamal installation and deployment flow](https://kamal-deploy.org/docs/installation/) and [proxy configuration](https://kamal-deploy.org/docs/configuration/proxy/).

compoza instead runs Compose against the selected host. A stack with a web service, worker and Redis stays expressed in Compose. In Kamal, you would describe the application roles and supporting containers in Kamal configuration; its **accessories** have a separate lifecycle and do not receive the main application's gapless deployment behavior. See [Kamal accessories](https://kamal-deploy.org/docs/configuration/accessories/).

The traffic-switching difference matters. compoza does **not** create an old/new application pair and switch traffic between them. Compose may recreate a service before the ingress step runs. A graceful Caddy reload only protects that proxy configuration change; it does not make the whole application deployment zero-downtime. The public HTTP wait also accepts statuses below 500, so it is a reachability check rather than a strict application readiness assertion. See [deployment and lifecycle](ingress.md#deployment-and-lifecycle).

compoza offers registry, `ssh-load` and `remote-build` image transport, and selects Caddy, an existing Cloudflare Tunnel, or no managed ingress. Its 1Password extension reads a **1Password Environment through the SDK**. Kamal also supports external secret helpers, including 1Password CLI vault/item lookups; external secret storage alone is not a differentiator. See [image transport](configuration.md#execution-and-transport), [our secret providers](secrets.md) and [Kamal secret adapters](https://kamal-deploy.org/docs/commands/secrets/).

**Choose compoza** when retaining your Compose stack and integrating with an existing ingress setup matter most. **Choose Kamal** when its application deployment model and coordinated traffic switch fit your service better. Kamal can target several servers, but its documented multi-server setup still requires a load balancer in front of them; that is separate from switching application versions on a host. See [Kamal's multi-server setup](https://kamal-deploy.org/docs/installation/).

## Compared with Dokploy

Dokploy adds a persistent management application and configuration database, with Traefik handling routing. Its interface includes deployment management, logs, resource monitoring and database backup workflows. Those are capabilities you would assemble separately around compoza. See [Dokploy architecture](https://docs.dokploy.com/docs/core/architecture) and [features](https://docs.dokploy.com/docs/core/features).

Dokploy also supports existing Compose definitions, Git-triggered deployments and a separate Docker Stack mode for Swarm. Choosing compoza is therefore about preferring a CLI and file-based configuration, not about gaining Compose support that Dokploy lacks. Docker Stack mode has different constraints, including no Compose `build` support. See [Dokploy Compose and Stack](https://docs.dokploy.com/docs/core/docker-compose).

Dokploy distinguishes independent remote servers from nodes joined to a shared Swarm cluster. The latter can run application replicas across machines; merely adding remote servers does not create that cluster. compoza selects one host per deployment and provides no cross-host scheduler, replica placement or automatic failover. See [Dokploy deployment options](https://docs.dokploy.com/docs/core/deployment-options).

Dokploy also supports resolving external secret references at deployment time. Our credential extension interface is a different integration model, not evidence that a dashboard requires copying all secrets into its database. See [Dokploy secret providers](https://docs.dokploy.com/docs/core/secrets-providers).

**Choose compoza** for a file-based workflow without a management service to operate. **Choose Dokploy** when the integrated UI and operational features are worth maintaining that platform and its state.

## Compared with Coolify

Coolify stores resource configuration in its management instance and uses SSH to run Docker operations on connected servers. Its dashboard/API is separate from application traffic, and it does not require a persistent deployment agent on each server. Avoid treating “uses SSH” or “agentless” as unique to compoza. See [how Coolify works](https://coolify.io/docs/core/how-coolify-works).

Coolify supports both Git-based Compose applications and Compose definitions entered directly as services. The Git-based path supports deployment webhooks and previews; the pasted service path has no Git event source. compoza has named destinations and can be invoked from CI, but it does not include a webhook service or automatic pull-request preview lifecycle. See [Coolify Compose workflows](https://coolify.io/docs/applications/builds/docker-compose).

Coolify's documented multi-server application deployment requires an external traffic layer and currently excludes Compose applications and applications with persistent storage configured. Compare the specific resource type you intend to deploy rather than assuming every platform feature applies to every Compose stack. See [Coolify multi-server deployment](https://coolify.io/docs/core/infrastructure/scaling/multi-server-deployments).

**Choose compoza** when terminal/CI operation and your own configuration files are the desired interface. **Choose Coolify** when a platform dashboard/API and integrated resource workflows are the desired interface.

## Compared with Compose and your own scripts

Compose already supports production deployment on a single server, including production overrides and service recreation. compoza adds a shared workflow around those primitives: host selection, image delivery, readiness reports, credential resolution, ingress operations and, with SSH execution, stored releases and rollback. See [Docker's production guide](https://docs.docker.com/compose/how-tos/production/) and [our SSH deployment model](ssh-deployment.md).

If a short script already covers your needs, using Compose directly can be sufficient. compoza becomes useful when repeated scripts across repositories need consistent configuration, error handling and recovery. It adds its own schema and runtime to learn and maintain; it does not remove Docker or Compose from the operational model.

## Boundaries to understand before choosing

- **Release history is opt-in.** Client execution is the default. Versioned releases and `rollback` require `execution: "ssh"`. Rollback restores configuration and image references using the currently active secret source; it does not reverse migrations or restore database contents.
- **Hosts are independent.** A host inventory and multiple destinations let you select targets; they do not form a cluster or supply automatic failover.
- **Extensions are bundled.** Caddy, Cloudflare Tunnel, dotenv and 1Password live in separate source folders behind defined contracts. There is no plugin marketplace or dynamic extension installation. See [extension architecture](development.md#extensions).
- **Ingress has a limited scope.** Caddy can be bootstrapped or integrated with an existing stack. The tunnel extension manages app routes in an existing remotely managed tunnel; it does not provision connectors, tunnels or DNS. See [ingress responsibilities](ingress.md).
- **Operations remain yours.** The CLI provides status, logs, checks and recovery commands. It has no central team dashboard, deployment queue, automatic application rollback, backup scheduler or continuous reconciliation service. Caddy hardening does not supply high availability; see [production operations](caddy-production.md).

When evaluating a migration, reuse Dockerfiles, images and suitable Compose definitions, then review the target tool's networking, secret handling, volume paths and deployment behavior. `deploy.json`, host references, Caddy templates and stored release metadata are specific to compoza; they are not interchangeable with another tool's configuration.
