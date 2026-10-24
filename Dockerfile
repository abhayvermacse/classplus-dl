# classplus-dl — Railway / any Docker host
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ./
RUN mkdir -p /app/files
# Railway injects PORT; HOST must be 0.0.0.0 (container proxy)
ENV HOST=0.0.0.0 \
    OUT_DIR=/app/files
EXPOSE 8777
CMD ["node", "server.js"]
