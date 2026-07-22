# BIII Hermes trust node — always-on, read-only, containerized (Layer 2).
# Build context = the biii repo root. Railway (or any container host) builds + runs this 24/7.
# The ONLY secret is OPENROUTER_API_KEY, injected at RUN time as an env var — never baked in.
FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git nodejs npm gettext-base ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Hermes runtime (the read-only agent loop) — installed from source, same as the proven node.
RUN git clone --depth 1 https://github.com/NousResearch/hermes-agent.git /app/hermes-src \
    && pip install --no-cache-dir -e "/app/hermes-src[cli,mcp]"

# The portable brain = this biii repo (guard, biii-mcp, memory-mcp, gl-bridge, skills, config template).
COPY . /app/biii

# lawbor toolset — best-effort. If the repo is private/unreachable the node still runs
# (biii + guard + the keyless watchdog); the lawbor toolset simply fails closed.
RUN git clone --depth 1 https://github.com/philpof102-svg/lawbor.git /app/lawbor \
    || echo "lawbor skipped (private/unreachable) — biii + guard + watchdog still run"

# gl (gitlawb CLI) is optional; the gitlawb toolset fails closed if it is absent. Add it in a
# later layer / via `gl register` once you want the fleet to coordinate this node.

ENV HERMES_HOME=/app/home
ENV HERMES_MODEL=tencent/hy3
ENTRYPOINT ["bash", "/app/biii/hermes/node/entrypoint.sh"]
