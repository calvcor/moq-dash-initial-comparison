# Origen de @moq/watch y de los paquetes @moq/* de los que depende. "release" (por defecto): los publicados en
# npm, fijados en package-lock.json. "git": compilados desde el commit MOQ_WATCH_COMMIT de moq, para medir
# versiones aún no publicadas. Docker solo construye la etapa que se elige. Se pasa desde docker-compose.yml.
ARG MOQ_WATCH_FROM=release

FROM alpine:3.22 AS moqwatch-release
RUN mkdir /pkgs

# Paquetes compilados desde un commit, empaquetados como los publica moq (su build + js/common/package.ts).
# Al instalar en Linux, el lockfile de moq no trae dos cosas que hacen falta y se añaden en la versión que fija:
# el binario nativo de rolldown (el empaquetador de vite) y pako (dependencia de @moq/flate). Sin pako, el
# build de flate, json, hang y watch falla y se empaquetarían sus fuentes .ts sin compilar: por eso se exige
# dist/package.json antes de empaquetar cada uno. Se identifican como git@<commit> en el panel y en el CSV.
FROM oven/bun:1.3.5 AS moqwatch-git
ARG MOQ_WATCH_COMMIT=bc64b9c52561209322dcb8dec9992bf867f499f7
ADD https://codeload.github.com/moq-dev/moq/tar.gz/${MOQ_WATCH_COMMIT} /tmp/moq.tar.gz
WORKDIR /moq
RUN tar -xzf /tmp/moq.tar.gz --strip-components=1 && bun install --frozen-lockfile
RUN set -e; \
    case "$(uname -m)" in aarch64) arch=arm64 ;; *) arch=x64 ;; esac; \
    rolldown=$(bun -e 'console.log(require("/moq/node_modules/rolldown/package.json").version)'); \
    pako=$(grep -o '"pako@[0-9][^"]*"' bun.lock | head -1 | tr -d '"' | cut -d@ -f2); \
    mkdir /tmp/extra && cd /tmp/extra && bun add "@rolldown/binding-linux-$arch-gnu@$rolldown" "pako@$pako" && \
    cp -r node_modules/@rolldown/. /moq/node_modules/@rolldown/ && cp -r node_modules/pako /moq/node_modules/
RUN set -e; mkdir /pkgs; \
    for p in clock signals pattern net flate json loc hang msf video watch; do \
      (cd js/$p && bun run build); \
      test -f js/$p/dist/package.json; \
      (cd js/$p/dist && bun pm pack --destination /pkgs); \
    done; \
    printf 'git@%.7s' "${MOQ_WATCH_COMMIT}" > /pkgs/label

FROM moqwatch-${MOQ_WATCH_FROM} AS moqwatch

FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
# Con MOQ_WATCH_FROM=git, los @moq/* apuntan a los paquetes compilados (también los que llegan como
# dependencia, con overrides) y se descarta el lockfile, que fija los de npm
COPY --from=moqwatch /pkgs ./moq-pkgs
RUN if ls moq-pkgs/*.tgz >/dev/null 2>&1; then \
      node -e ' \
        const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); \
        const tgz = fs.readdirSync("moq-pkgs").filter((f) => f.endsWith(".tgz")); \
        const file = (n) => "file:moq-pkgs/" + tgz.find((f) => f.startsWith(n.slice(1).replace("/", "-") + "-") && /^[0-9]/.test(f.slice(n.length))); \
        const names = tgz.map((f) => "@" + f.replace(/-[0-9][^-]*\.tgz$/, "").replace("-", "/")); \
        p.overrides = Object.fromEntries(names.map((n) => [n, file(n)])); \
        p.dependencies["@moq/watch"] = file("@moq/watch"); \
        fs.writeFileSync("package.json", JSON.stringify(p, null, 2)); \
        console.log(p.overrides);' && \
      rm -f package-lock.json; \
    fi && npm install

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
    listen 80;
    server_name localhost;

    # Habilitar Cross-Origin Isolation para permitir SharedArrayBuffer en AudioWorklet
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Cross-Origin-Embedder-Policy require-corp always;

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
