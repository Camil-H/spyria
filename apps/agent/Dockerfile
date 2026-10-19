FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG PACKAGES
RUN npm install -g ${PACKAGES} && npm cache clean --force
RUN userdel -r node 2>/dev/null; groupadd -g 10001 openhands && useradd -u 10001 -g 10001 -m -d /home/openhands openhands \
  && mkdir -p /workspace/project /home/openhands/.claude /home/openhands/.codex && chown -R 10001:10001 /workspace /home/openhands
ENV CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude CODEX_PATH=/usr/local/bin/codex
COPY dist/spyria-agent /usr/local/bin/spyria-agent
COPY pi/ /usr/local/lib/spyria/pi/
WORKDIR /workspace/project
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/spyria-agent"]
