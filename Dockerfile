# Tucano on a server, in a container (docs/server.md): the same image the Tucano Pro servers run, one
# container per person. The image holds the program and the harnesses; everything a person makes, and
# their harness logins, lives in /home/tucano, the container's volume.
#
#   docker build -t tucano .
#   docker run -d --name tucano -p 127.0.0.1:7337:7337 -v tucano:/home/tucano tucano
#   docker exec tucano node out/main/server.js link

FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts
# whisper-cli for dictation: whisper.cpp's own build, checked against its SHA-256.
RUN node scripts/whisper.mjs linux "$(node -p 'process.arch')" && mv "build/whisper/linux-$(node -p 'process.arch')" /whisper

FROM node:24-bookworm-slim
# chromium: the agents' browsers. git, openssh-client, ripgrep: what the harnesses expect around them.
# bsdutils: `script`, which signing a harness in from Settings › Models runs. tini: a real init, so a
# harness or a Chrome left behind is reaped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji bsdutils ca-certificates curl git libgomp1 openssh-client ripgrep procps tini \
  && rm -rf /var/lib/apt/lists/*
# The harnesses, on the image so an image update updates them. Their own updaters stay off: they
# couldn't write here anyway, and a container should change only with its image.
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai @earendil-works/pi-coding-agent && npm cache clean --force
# Cursor's, Grok's and Antigravity's CLIs come from their own installers, which install into a home: one of
# the image's (/home/tucano is the volume, and an image update wouldn't reach it), linked onto the PATH.
RUN HOME=/opt/harnesses bash -c 'curl -fsS https://cursor.com/install | bash && curl -fsSL https://x.ai/cli/install.sh | bash && curl -fsSL https://antigravity.google/cli/install.sh | bash' \
  && ln -sf /opt/harnesses/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
  && ln -sf /opt/harnesses/.grok/bin/grok /usr/local/bin/grok \
  && ln -sf /opt/harnesses/.local/bin/agy /usr/local/bin/agy \
  && chmod -R a+rX /opt/harnesses
ENV DISABLE_AUTOUPDATER=1

# The person's user. Fixed ids, so a volume keeps its owner across images.
RUN groupadd -g 10001 tucano && useradd -u 10001 -g tucano -m -d /home/tucano -s /bin/bash tucano

WORKDIR /opt/tucano
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/out ./out
COPY --from=build /whisper /opt/whisper
COPY --chmod=755 docker/chrome /usr/bin/google-chrome-stable

ENV NODE_ENV=production \
    TUCANO_HOST=0.0.0.0 \
    TUCANO_PORT=7337 \
    TUCANO_DATA=/home/tucano/.tucano-server \
    TUCANO_WHISPER=/opt/whisper \
    HOME=/home/tucano \
    SHELL=/bin/bash
USER tucano
VOLUME /home/tucano
EXPOSE 7337
# Up when the server answers (without the token, it says so with a 401).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:7337/').then(r=>process.exit(r.status===401?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "out/main/server.js"]
