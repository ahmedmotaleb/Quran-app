# One image: the built PWA + the Django API, served from the same origin.
# Build:  docker build -t halqa .
# Run:    docker run -p 10000:10000 --env-file .env halqa

ARG NODE_IMAGE=node:22-slim
ARG PYTHON_IMAGE=python:3.13-slim

# ---- 1. Build the PWA (live mode: same-origin /api) ----------------------------------------
FROM ${NODE_IMAGE} AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
ENV VITE_API_BASE_URL=/
RUN npm run build

# ---- 2. Django API + static PWA -------------------------------------------------------------
FROM ${PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FRONTEND_DIST=/app/dist PORT=10000
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
COPY backend/ .
COPY --from=web /app/dist /app/dist
# Settings need a database URL at import time; collectstatic does not connect to it.
RUN APP_ENV=development DATABASE_URL=postgres://build@localhost/build python manage.py collectstatic --noinput \
 && useradd --create-home --uid 10001 app && chown -R app /app
USER app
EXPOSE 10000
CMD ["sh", "./start.sh"]
