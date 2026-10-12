# The hosted demo as one container (render.yaml): the backend serves the API and the
# built web app on $PORT and forwards camera frames to the CV service, which listens
# only inside the container. One URL, no CORS set-up, fits Render's free plan.
# Local development uses docker-compose.yml (separate services) instead.
#
#   docker build -t pulsepay .
#   docker run -p 10000:10000 --env-file .env -e DATABASE_URL=... pulsepay

# --- web app ------------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Same-origin base URLs: the page calls /api/... and /cv/... on its own host.
RUN VITE_API_URL=/ VITE_CV_URL=/cv npm run build

# --- runtime: Node backend + Python CV service -------------------------------------
FROM node:22-bookworm-slim
# opencv-python-headless needs no libGL or GUI libraries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY cv-service/requirements.txt cv-service/
RUN python3 -m venv /opt/cv && /opt/cv/bin/pip install --no-cache-dir -r cv-service/requirements.txt

COPY backend/package.json backend/package-lock.json backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund

COPY backend/ backend/
COPY cv-service/ cv-service/
COPY database/ database/
COPY scripts/start-hosted.sh ./
COPY --from=web /web/dist web/

ENV NODE_ENV=production \
    PORT=10000 \
    FRONTEND_DIR=/app/web \
    CV_SERVICE_URL=http://127.0.0.1:8000 \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 10000
USER node
CMD ["bash", "start-hosted.sh"]
