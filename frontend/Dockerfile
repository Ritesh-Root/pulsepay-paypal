# PulsePay-SBI frontend (Vite + React). Dev server for the hackathon demo.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
