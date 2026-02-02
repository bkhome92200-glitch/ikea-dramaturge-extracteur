# Image officielle Playwright avec Chromium déjà installé
FROM mcr.microsoft.com/playwright:v1.41.0-jammy

# Dossier de travail
WORKDIR /app

# Copier package.json
COPY package.json ./

# Installer les dépendances
RUN npm install --production

# Copier le code
COPY src ./src

# Port exposé
EXPOSE 3000

# Lancer le microservice
CMD ["npm", "start"]
