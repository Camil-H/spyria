FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libx11-6 libxcb1 libxext6 libpango-1.0-0 libcairo2 \
  libasound2 fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
COPY pi/package.json pi/package-lock.json /usr/local/lib/spyria/pi/
RUN npm ci --omit=dev --prefix /usr/local/lib/spyria/pi && npm cache clean --force \
  && ln -s /usr/local/lib/spyria/pi/node_modules/.bin/pi /usr/local/bin/pi
RUN userdel -r node 2>/dev/null; groupadd -g 10001 openhands && useradd -u 10001 -g 10001 -m -d /home/openhands openhands \
  && mkdir -p /workspace/project /home/openhands/.claude /home/openhands/.codex /harnesses /var/cache/spyria \
  && chown -R 10001:10001 /workspace /home/openhands /harnesses /var/cache/spyria
COPY browser/package.json browser/package-lock.json browser/screenshot.mjs /usr/local/lib/spyria/browser/
RUN npm ci --omit=dev --prefix /usr/local/lib/spyria/browser && npm cache clean --force \
  && node /usr/local/lib/spyria/browser/screenshot.mjs install
COPY dist/spyria-agent /usr/local/bin/spyria-agent
COPY pi/*.ts /usr/local/lib/spyria/pi/
WORKDIR /workspace/project
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/spyria-agent"]
