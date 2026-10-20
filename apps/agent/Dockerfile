FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY pi/package.json pi/package-lock.json /usr/local/lib/spyria/pi/
RUN npm ci --omit=dev --prefix /usr/local/lib/spyria/pi && npm cache clean --force \
  && ln -s /usr/local/lib/spyria/pi/node_modules/.bin/pi /usr/local/bin/pi
RUN userdel -r node 2>/dev/null; groupadd -g 10001 openhands && useradd -u 10001 -g 10001 -m -d /home/openhands openhands \
  && mkdir -p /workspace/project /home/openhands/.claude /home/openhands/.codex /harnesses \
  && chown -R 10001:10001 /workspace /home/openhands /harnesses
COPY dist/spyria-agent /usr/local/bin/spyria-agent
COPY pi/*.ts /usr/local/lib/spyria/pi/
WORKDIR /workspace/project
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/spyria-agent"]
