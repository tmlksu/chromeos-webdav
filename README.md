# WebDAV for Files (ChromeOS)

[![CI](https://github.com/tmlksu/chromeos-webdav/actions/workflows/ci.yml/badge.svg)](https://github.com/tmlksu/chromeos-webdav/actions/workflows/ci.yml)

English | [日本語](README.ja.md)

A Chrome extension that mounts a WebDAV share in the ChromeOS Files app.
It uses `chrome.fileSystemProvider` and **fetches only the bytes you actually read,
with Range GET**, so a large video starts playing without waiting for the whole
file to download.

**Read-only.** Zero dependencies, no build step.

```
ChromeOS Files app
 └ this extension (chrome.fileSystemProvider, MV3)
     └ HTTPS fetch
         └ [no auth | Cloudflare Access]
             └ WebDAV server (rclone / Nextcloud / Apache mod_dav / …)
```

## How this relates to the existing extension

For a long time the way to mount WebDAV on ChromeOS was
[`yoichiro/chromeos-filesystem-webdav`](https://github.com/yoichiro/chromeos-filesystem-webdav),
but that one is built as a **Manifest V2 Chrome App**. Chrome Apps and MV2 have
both reached end of support, so it no longer runs on current ChromeOS.

This project is a rewrite as an MV3 extension, and additionally has

- Range GET that fetches only what you read (large videos start playing right away)
- support for shares sitting behind Cloudflare Access
- zero dependencies and no build step

It was written from scratch rather than ported, so it shares no code with it.

## Requirements

- ChromeOS (Chrome 120 or later)
- A WebDAV server that answers PROPFIND and **Range GET (206)**

If you don't have a server yet, `docker/` has an rclone example.

## Install

It is not on the Chrome Web Store, so load it unpacked.

1. Download and unzip the [latest release](../../releases), or clone this repository
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. **Load unpacked** → pick the directory to load
   - If you unzipped a release, pick **the unzipped directory itself**
     (`manifest.json` is directly inside it)
   - If you cloned the repository, pick `extension/`

## Configuration

Click the extension icon to open the settings page (Files app →
**Add new service** opens it too).

| Field | Description |
| --- | --- |
| Display name | The name shown in the Files app sidebar |
| URL | `https://dav.example.com`, or `https://example.com/dav` if served under a subpath |
| Auth mode | See below |
| Auto-mount | Mount at browser startup |

**Test connection** checks that PROPFIND works before you save.
When you save a URL, Chrome asks you to grant access to that origin
(the extension uses `optional_host_permissions`, so you only hand it the hosts
it actually needs).

You can register several shares; each appears as its own drive in the Files app.

### Auth modes

**No auth** — connects to the server directly. Only use this when the server is
**protected at the network layer**: Tailscale, WireGuard, a LAN, and so on.

**Basic auth** — for servers that hold their own username and password
(Nextcloud, Synology WebDAV Server, `dufs --auth`, and so on).

The credentials are **stored in cleartext** in `chrome.storage.local`. No other
extension can read them, but they are not encrypted on disk. Because of that they
can only be set on an `https://` share. If your server can issue app passwords
(Nextcloud can), use one of those rather than your account password.

**Cloudflare Access** — for servers behind a
[self-hosted application](docs/cloudflare-access.md) (the doc is in Japanese).
When the session expires the extension opens a login tab, detects that the
`CF_Authorization` cookie has been set, closes the tab and resumes the
interrupted requests. However many requests are in flight, only one login tab
ever opens.

## Verified servers

Verification splits in two.

- **Protocol layer** — how PROPFIND is interpreted, whether hrefs round-trip,
  Range GET. `test/live.mjs` checks this against a real server. It needs neither
  ChromeOS nor the chrome APIs, so several implementations are stood up in Docker
  and checked automatically.
- **Files app** — whether it actually mounts and opens. This needs a Chromebook.

| Server | Auth | Protocol layer | Files app |
| --- | --- | --- | --- |
| `rclone serve webdav` | none | 66/66 | verified (both directly and via Cloudflare Access) |
| Apache `mod_dav` | none | 66/66 | not checked |
| [dufs](https://github.com/sigoden/dufs) | none / Basic | 66/66 | not checked |
| [hacdias/webdav](https://github.com/hacdias/webdav) | none | 66/66 | not checked |
| [Nextcloud](https://nextcloud.com/) | Basic | 149/149 | not checked |
| nginx (built-in `dav` module) | — | **not supported** | — |

Nextcloud exercises two paths the others don't: it requires Basic auth, and it
serves from a subpath (`/remote.php/dav/files/<user>`), so the baseurl handling
goes through it too.

nginx's built-in `ngx_http_dav_module` has no PROPFIND — only the writing
methods. Without `nginx-dav-ext-module` it isn't WebDAV, and PROPFIND returns 405.

Synology WebDAV Server is untested for lack of hardware, but should work over
Basic auth.

You can run the whole set locally:

```bash
npm run test:compat            # stand the implementations above up in docker and test them
npm run test:compat -- dufs    # just one
```

If you try another WebDAV implementation, please report the result in an issue —
it goes in the table. Pointing `node test/live.mjs <URL>` at your own server is
all it takes.

## Development

```bash
npm test        # unit tests (no chrome APIs needed)
npm run check   # syntax check + manifest.json validation
npm run package # build dist/webdav-for-files-<version>.zip

npm run fixtures            # regenerate fixtures from rclone's real output
npm run test:compat         # compatibility test across WebDAV implementations (docker)
node test/live.mjs <URL>    # integration test against a running server
```

There are no dependencies (`npm install` is not needed). Node 20 or later.

What CI runs reproduces locally as-is. Neither ChromeOS nor the chrome APIs
are involved:

```bash
bash test/tools/make-tree.sh /tmp/davtree     # a test tree of deliberately awkward names
DAV_SHARE_PATH=/tmp/davtree docker compose -f docker/docker-compose.yml up -d
node test/live.mjs http://127.0.0.1:8080
```

`test/live.mjs` assumes nothing server-specific. It walks the tree and checks
that a path it got from a listing can be fetched back as-is, and that a Range GET
agrees with a full GET. Point it straight at your own WebDAV server:

```bash
node test/live.mjs https://dav.example.com                    # no auth
DAV_USER=u DAV_PASS=p node test/live.mjs https://dav.example.com   # server with Basic auth
CF_ACCESS_TOKEN=$(cloudflared access token -app=https://dav.example.com) \
  node test/live.mjs https://dav.example.com                  # via Cloudflare Access
```

## Design notes

Recorded so that anyone reimplementing this doesn't fall into the same traps.

- **The XML parsing is hand-written.** `DOMParser` isn't available in a service
  worker, so `dav.js` has a small scanner that walks tag by tag (zero
  dependencies). It's a state machine rather than a regex, so it doesn't trip
  over a `>` inside an attribute, self-closing tags, or differing namespace
  prefixes (`D:` / `d:` / `lp1:`).
- **Multiple propstat are handled.** For a prop-limited PROPFIND, rclone splits
  its answer: properties that exist go in a 200 propstat, ones that don't in a
  404 propstat. Unless you take only the 2xx propstat, a directory's
  `getcontentlength` gets overwritten with an empty string.
- **Entry names are derived from `href`, not `displayname`.** A name handed to
  FSP comes straight back as the path of the next request, so unless it
  round-trips with the href you end up with entries that list but won't open.
  Servers differ on whether they encode `+` `=` `'` `(` `~`, which makes this
  worth checking against a real server (`test/live.mjs` does).
- **Some servers refuse a Range that crosses end of file with 416.** RFC 7233
  asks servers to truncate at the end, and rclone and Apache do, but dufs
  refuses. FSP reads in fixed-size chunks, so **the last chunk of every file
  crosses the end** — meaning every file is affected, and any file smaller than
  one chunk comes back completely empty. Only when refused does the extension
  retry with an open-ended `bytes=N-`. It doesn't always use the open-ended form
  because that sends the entire remainder (gigabytes, for a video), which is the
  opposite of streaming.
- **Metadata goes through a short-lived cache.** When a directory is opened the
  Files app fetches the listing once, then sends `onGetMetadataRequested` for
  each child to render it. Done naively that is 1 + N PROPFINDs, and over a
  tunnel one round trip's latency becomes N of them. The Depth:1 response
  already contains every child's metadata, so it is kept for a few seconds.
  The extension is read-only, so nothing breaks if what you see is slightly
  stale, and the cache dies with the service worker.
- **Only redirects and 401 count as an expired Access session.** Treating every
  non-2xx as expired would pop a login tab on every 404 (missing file) and 403
  (policy denial). 404 maps to `NOT_FOUND` and 403 to `ACCESS_DENIED`; only
  `opaqueredirect`, status 0 and 401 are treated as expiry.
- **Login is single-flight.** The Files app fires several requests at once when
  a directory is opened, so without a gate you get several login tabs.
- **The login tab is not closed on timeout.** 90 seconds can be short for
  entering an MFA code. The tab is left open and reused by the next login.
- **The service worker is assumed to die.** The `fileSystemId + openRequestId →
  path` mapping for open files is kept in `chrome.storage.session` and restored
  lazily inside the handlers.
- **`fileSystemId` is derived deterministically from the URL.** Removing a share
  and adding it back produces the same id, so it can't disagree with mount state
  left over on the ChromeOS side.
- **Basic auth credentials can only be held in cleartext.** An extension has no
  storage keyed to the user, so encrypting them would mean keeping the key in the
  same place. Rather than obfuscate and look safe, the settings page says plainly
  that they are stored in cleartext and the mode is restricted to `https://`.
  A redirect to another origin is rejected, since `fetch` does not drop the
  Authorization header across one.
- **`host_permissions` are optional.** MV3 can't change static `host_permissions`
  at runtime, so this uses `optional_host_permissions` plus
  `chrome.permissions.request()` from the settings page. That call requires a
  user gesture, so permission requests always happen on the settings page.

## Not implemented

- Writing (`onCreateFile` / `onWriteFile` / `onDeleteEntry` / `onMoveEntry`)
- Thumbnails (`thumbnail` in `onGetMetadataRequested`)
- Bearer tokens
- File watching (`watchable`)

## Documentation

`docs/` is currently Japanese-only:

- [docs/cloudflare-access.md](docs/cloudflare-access.md) — putting the server behind Cloudflare Access
- [docs/troubleshooting.md](docs/troubleshooting.md) — troubleshooting

## License

MIT
