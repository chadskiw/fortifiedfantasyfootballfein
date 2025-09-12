FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev
COPY src ./src
COPY .env.example ./.
ENV NODE_ENV=production
EXPOSE 5050
CMD ["node", "src/server.js"]
