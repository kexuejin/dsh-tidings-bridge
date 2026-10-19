# dsh-tidings-bridge

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that bridges a DSH session to the local **Tidings (捎话)** node — the resident peer of the Tidings desktop app that owns the LAN messaging protocol.

The plugin talks **only** to the agentNode loopback HTTP control plane (`http://127.0.0.1:8788` by default). It never touches the wire protocol itself: discovery, handshakes, and the offline replay queue all live in agentNode. This package is a projection of that control plane into DSH, plus a pusher that feeds DSH's own session and workspace state back into it.

What you get after installing:

- **Nine agent tools** — an agent inside a DSH session can read node status, list peers, read the inbox, send messages, and announce its own sessions and workspaces to your phone (PPE-1).
- **One settings card** — since 2026-10-14 the plugin no longer owns a sidebar panel. What remains is a single card under DSH's settings navigation: connection state, the auto-announce switch, the control-plane address, and the access token. Configure once, then it works silently.

## Prerequisites

The plugin is a client of a running agentNode. Two ways to have one:

- **Tidings desktop app** (recommended) — it listens on `127.0.0.1:8788` natively from its tray, so there is no process to babysit.
  Get it from [**kexuejin/tidings**](https://github.com/kexuejin/tidings) — the repository this plugin serves (protocol, runtime and the `agentNode` control plane all live there).
- **Headless agentNode** — build the `agentNode` module from the Tidings source tree and run it with `--http-port 8788`. The `--http-port` listener binds loopback only.

By default no token is required (loopback is trusted). If you start agentNode with `--token` or `TIDINGS_AGENT_TOKEN`, enter the same token in the settings card; it is stored in DSH's credential store and never echoed back to the page.

## Install

### Option 1: Official npm Registry (Recommended)

```sh
dsh plugin --profile web add dsh-tidings-bridge
```

### Option 2: As a Git Bundle (Builds on Install)

```sh
dsh plugin --profile web add github:kexuejin/dsh-tidings-bridge
```

pnpm refuses to run build scripts for git-hosted dependencies until you allow it, so the first `add` fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Copy the exact key pnpm prints into your profile's `pnpm-workspace.yaml` and run `add` again:

```yaml
allowBuilds:
  dsh-tidings-bridge@git+https://github.com/kexuejin/dsh-tidings-bridge.git#<commit-sha>: true
```

Treat that allowance as *permission for this package's code to run on your machine at install time*, outside any agent sandbox. Pin the commit (`#<sha>`) so a later push cannot silently change what gets executed.

### Option 3: Prebuilt Tarball

```sh
dsh plugin --profile web add ./dsh-tidings-bridge-0.1.0.tgz
```

For development, link a checkout:

```sh
dsh plugin --profile web add link:/path/to/dsh-tidings-bridge
```

## Agent tools

| Tool | Purpose |
| --- | --- |
| `tidings_status` | This node's status: nodeId, nickname, platform, ports, peer and online counts. Read-only, loopback only. |
| `tidings_list_peers` | Discovered peers: nickname, address, platform, online flag, last activity. |
| `tidings_read_inbox` | Incremental message reads by cursor (`since` / `limit`). |
| `tidings_send_message` | Send one text. `to` accepts a nickname, an IP, or a nodeId. |
| `tidings_agent_session` | Announce or update an agent session state (PPE-1 §6.1). |
| `tidings_agent_event` | Deliver a monotonically-cursorised structured event to a session (PPE-1 §6.2). |
| `tidings_agent_workspace` | Announce one of this host's workspaces (PPE-1 supplement D3). |
| `tidings_agent_grants` | Read or change which peers may see this host's agent data (PPE-1 supplement D7). |
| `tidings_announce_status` | Diagnostics for the auto-announcer: is it on, how many workspaces were announced, who the current audience is. Read-only. |

Two behaviours worth knowing before you rely on a result:

- **`queued` is not "read".** `sent` means the peer ACKed. `queued` means the peer is offline and the message waits in its replay queue.
- **A bare IP costs a handshake.** When `to` is an address rather than a known peer, agentNode sends an `entry` handshake and waits up to 3 seconds; if it fails you get `peer-unreachable` instead of a silent queue.

## Settings card

Registered at DSH's `settings.section` slot (id `tidings`, ordered early). It shows:

- **Connection state** — `已连接 · <nick> · N 个邻居在线`, or one of loading / unreachable / unauthorized. When unreachable, the card states the cause and offers the acquisition link rather than only an error.
- **Advanced (collapsed by default)** — the auto-announce switch and the control-plane address.
- **Refresh / close**, plus a one-line save notice.

Token entry goes through the credential store; the card reports only whether a token is present.

## Configuration

Config keys are DSH plugin config (patch layer or profile); the two the card writes live in `$DSH_HOME/tidings/config-v1.json` (atomic write, mode `0600`).

| Key | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8788` | agentNode control plane. |
| `tokenCredentialRef` | `TIDINGS_AGENT_TOKEN` | Credential ref; falls back to `process.env` when no credential provider is present. |
| `timeoutMs` | `8000` | Minimum 1000. |
| `defaultPort` | `17878` | Used when `to` is a bare address. |
| `inboxLimit` | `30` | 1–200. |
| `autoAnnounce` | `true` | Off = pure manual mode: no listeners registered, no frames sent. |
| `announceTargets` | `[]` | Audience allowlist (nodeId / IP / nickname). Empty = every peer the control plane currently reports online. |

**Privacy note.** With the default audience, an announcing host pushes session titles and workspace paths to every online peer. A misconfigured or unknown device that comes online would receive them too. Set `announceTargets` to narrow the exposure, or turn `autoAnnounce` off.

## Repository layout

```text
src/
  index.ts                      host half: plugin meta, Config schema, the nine tools
  tidings.ts                      HTTP client for the agentNode control plane + token resolution
  announce.ts                   automatic announcement of DSH sessions and workspaces
  session-pages.ts              session-page entry point
  session-page-responder.ts     answers the phone's paged session requests (PPE-1 D8)
  workspace-registry.ts         stable workspace and agent identity for this host
  model.ts                      shared wire surface: RPC channel, endpoints, every cross-boundary view
  rpc.ts                        host half of the loopback RPC channel (13 endpoints)
  config-store.ts               non-secret settings persistence
  client/
    index.ts                    browser half: registers the settings card and its dictionaries
    TidingsSettingsSection.tsx    the card itself
    TidingsSettingsSection.module.css
    locales.ts                  zh / en copy (a missing translation is a compile error)
    settings-slots.d.ts         the one slot this plugin occupies, declared locally
  css-modules.d.ts / host-services.d.ts   ambient declarations
scripts/check-*.mjs             seven gate scripts (see Development)
check-real.mjs                  round-trip against a live agentNode
docs/                           design notes and the panel prototype with its probe scripts
tsdown.config.ts                two builds: host ESM (lib/) and browser CJS loader (client/)
```

## Development

```sh
pnpm install
pnpm run build      # lib/index.js (host ESM) + client/client.js (browser CJS)
pnpm run typecheck  # tsconfig.host.json and tsconfig.client.json
pnpm run check      # typecheck + seven gates + build — what CI runs
```

Each gate exists because of a specific failure, and each one says so in its header comment:

| Gate | What it pins |
| --- | --- |
| `check:inject` | `inject` may only name baseline host services. A wrong hard dependency makes cordis refuse the **whole plugin with no log line**. |
| `check:announce` | Announcement accounting asks about **results**, not intentions, and state snapshots must re-assert within a window. |
| `check:title` | Title reads must follow the service's real return shape; a guard that is silently always false shows session ids everywhere. |
| `check:order` | Session order must come from DSH's own activity order, not creation order. |
| `check:activity` | The activity timestamp the phone sorts by must come from a real user action. |
| `check:visibility` | What the phone may show must match what DSH itself displays (no subagent sessions). |
| `check:css` | CSS module class names must exist on both sides — a typo must fail red, not render unstyled. |

```sh
pnpm run check:real   # build, then health/peers/inbox/send against a live agentNode
```

`check:real` is deliberately outside `check`: it needs a running agentNode (override the target with `TIDINGS_BASE_URL`). It uses the same `createTidingsClient` the plugin ships, so it proves the production code path works against a real control plane rather than a fake shell.

Design history lives in `docs/`: the 2026-10-14 panel-simplification decision, and `docs/prototype/` — the interactive prototype the IA was argued in, with a Chrome-headless screenshot script, a geometry probe, and 21 reference renders.

## License

MIT — see [LICENSE](LICENSE).
