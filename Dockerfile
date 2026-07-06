# Explicit Node build so Railway NEVER auto-detects this as a static site.
# (Railpack was mis-classifying this folder as static because it also contains
# index.html + assets, which broke every POST / login. A Dockerfile removes all
# guessing — it's always a Node app running "node index.js".)
FROM node:20-slim

WORKDIR /app

# Install production dependencies (no package-lock in the repo, so use npm install).
COPY package.json ./
RUN npm install --omit=dev

# Copy the rest of the app (index.js, index.html, tv.html, sw.js, static assets…).
COPY . .

# Railway provides PORT; the app reads process.env.PORT (falls back to 3000).
CMD ["node", "index.js"]
