FROM mcr.microsoft.com/playwright:v1.54.0-jammy

WORKDIR /app

COPY bridge/package.json ./bridge/package.json
WORKDIR /app/bridge
RUN npm install --omit=dev

WORKDIR /app
COPY bridge/src ./bridge/src
COPY bridge/resources/max-monitor.js ./bridge/resources/max-monitor.js

WORKDIR /app/bridge
CMD ["npm", "start"]
