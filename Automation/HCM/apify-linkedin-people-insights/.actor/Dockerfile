# Lean, browser-free image. This is the default because the actor's primary and
# secondary extraction tiers are plain HTTP — no Chromium, no ~1 GB image layer,
# no browser boot time. All three of those are Compute Units you don't spend.
#
# The browser fallback tier (`allowBrowserFallback`) cannot run on this image and
# will fail with an actionable error. If you genuinely need it, build with
# ../Dockerfile.browser instead (see README, "Choosing an image").
FROM apify/actor-node:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --no-audit --no-fund \
    && echo "Installed npm packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version

COPY . ./

CMD ["npm", "start", "--silent"]
