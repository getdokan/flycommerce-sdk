---
---

`app dev` runs cloudflared with an empty config of its own, so a named tunnel's `~/.cloudflared/config.yml` can't take over the quick tunnel, and checks that the tunnel reaches your port before it pushes anything. It moves `http://localhost:<port>` script srcs and install redirects onto the tunnel. `app release` refuses an `appUrl` or URL only this computer or a private network can reach, and `--dry-run` runs every check the release runs, failing the same way. All in the first release, 0.1.0.
