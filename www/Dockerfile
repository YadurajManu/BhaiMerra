FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# Where the dashboard lives, baked in at build time so the marketing CTAs
# point somewhere real rather than at a placeholder.
ARG VITE_APP_URL=https://app.fleet.plastikworld.xyz
ENV VITE_APP_URL=$VITE_APP_URL
RUN npm run build

FROM nginx:1.31.3-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
