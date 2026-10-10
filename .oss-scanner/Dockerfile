# OSS Scanner build image for jev-opus. Based on oss-scanner/templates/Dockerfile.
# The scanner builds this with the repository root as the build context. Network is available only during this
# build; the scan itself runs without Internet, so all dependencies are installed and the project is built here.
FROM node:22.23.0-bookworm
ENV DEBIAN_FRONTEND=noninteractive
# git: the evaluation-runner test resolves HEAD in the checkout, so it needs both git and the .git directory.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Same steps as CI (.github/workflows/ci.yml): clean install including devDependencies, then compile src/ to dist/.
RUN npm ci
RUN npm run build

# Unit tests (node:test over tests/*.test.ts). They use loopback servers and fixtures only and need no API key.
# A failing test does not abort the build; the log shows which test failed.
RUN npm run test || echo "WARNING: unit tests reported failures"
