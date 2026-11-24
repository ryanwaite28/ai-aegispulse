# syntax=docker/dockerfile:1
# Console image (PROJECT.md §5.4): nginx-unprivileged (non-root, port 8080), read-only root FS with writable /tmp.
# Phase 1e serves a placeholder; Phase 19 adds a node build stage for the Vite app.
FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/console/public/ /usr/share/nginx/html/
