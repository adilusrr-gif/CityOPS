FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

# The official image gives caddy CAP_NET_BIND_SERVICE as a file capability.
# Port 8080 does not need it, and cap_drop: ALL otherwise makes exec fail EPERM.
# Remove the file capability at build time; do not grant runtime privileges.
RUN setcap -r /usr/bin/caddy && test -z "$(getcap /usr/bin/caddy)"
USER 1000:1000
