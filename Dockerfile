FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Витрина (презентация, галерея, проигрыватель записей) — раздел того же сайта: /showcase/
FROM node:22-alpine AS showcase
WORKDIR /app/showcase
COPY showcase/package.json showcase/package-lock.json ./
RUN npm ci
COPY contracts/design-tokens.css /app/contracts/design-tokens.css
COPY showcase/ ./
RUN npm run build

FROM python:3.11-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app/backend
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
COPY --from=showcase /app/showcase/dist /app/frontend/dist/showcase
EXPOSE 10000
CMD ["sh", "-c", "exec uvicorn bagdar.api.app:app --host 0.0.0.0 --port ${PORT:-10000}"]
