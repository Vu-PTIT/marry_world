FROM node:24-bookworm-slim AS client
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
COPY public ./public
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt \
    && useradd --create-home --uid 10001 wedding \
    && mkdir /app/.runtime && chown wedding:wedding /app/.runtime
COPY backend/app ./backend/app
COPY backend/__init__.py ./backend/__init__.py
COPY shared ./shared
COPY --from=client /build/dist ./dist
COPY --from=client /build/public ./public
USER wedding
EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=3 CMD ["python", "-c", "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3))['status']=='ok'"]
CMD ["python", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--ws-max-size", "8192", "--ws-max-queue", "16", "--no-access-log", "--no-proxy-headers"]
