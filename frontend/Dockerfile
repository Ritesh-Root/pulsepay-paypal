# PulsePay frontend (Vite + React), served by the Vite dev server for the local demo.
# Render builds it as a static site instead (see render.yaml).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
