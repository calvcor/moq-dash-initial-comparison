# Origen del publicador moq-cli. "release" (por defecto): el binario publicado, fijado abajo. "git": compilado
# desde el commit MOQ_CLI_COMMIT, para medir versiones aún no publicadas. Docker solo construye la etapa que se
# elige, así que con "release" no se compila nada. Se pasa desde docker-compose.yml (variables del .env).
ARG MOQ_CLI_FROM=release

# Herramienta vmaf de Netflix, compilada aparte: Debian no la empaqueta y el FFmpeg de Debian no trae
# libvmaf. Así el FFmpeg que codifica la fuente no cambia. Solo se usa para la QoE (qoe.py), con la
# emisión parada. v3.0.0 desde el 20 de octubre de 2026; el modelo vmaf_v0.6.1 va dentro del binario.
FROM python:3.12-slim AS vmaf
ARG VMAF_VERSION=3.0.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential meson ninja-build nasm xxd curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/Netflix/vmaf/archive/refs/tags/v${VMAF_VERSION}.tar.gz" | tar -xz -C /tmp && \
    cd /tmp/vmaf-${VMAF_VERSION}/libvmaf && \
    meson setup build --buildtype=release --default-library=static -Denable_tests=false -Denable_docs=false && \
    ninja -C build && \
    install -m 755 build/tools/vmaf /usr/local/bin/vmaf

FROM python:3.12-slim AS moqcli-release
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Descargar e instalar el binario dinámico oficial de moq-cli para Linux (soporta amd64 y arm64)
# 0.14.7 desde el 19 de octubre de 2026. Con un espectador, una calidad: entrada del publicador sin esperas (máx.
# 37 ms) y MoQ sin congelados; tres calidades: sin retraso acumulado, con picos de hasta 2 s como con 0.14.3.
# Antecedentes: con 0.14.4 el publicador lee su entrada más despacio que el ritmo de la fuente y
# acumula retraso sin parar (14 de octubre de 2026: 16-18 s de espera al minuto y medio). Con 0.14.5 aguanta
# sin espectadores, pero con uno se queda atrás (15 de octubre, tres calidades: 3 s de espera mediana y MoQ
# a 2 s de latencia; con una calidad, 49 congelados en 85 s frente a 13 con 0.14.3).
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
        URL="https://github.com/moq-dev/moq/releases/download/moq-cli-v0.14.7/moq-cli-v0.14.7-aarch64-unknown-linux-gnu.tar.gz"; \
    else \
        URL="https://github.com/moq-dev/moq/releases/download/moq-cli-v0.14.7/moq-cli-v0.14.7-x86_64-unknown-linux-gnu.tar.gz"; \
    fi && \
    echo "Descargando moq-cli oficial desde $URL..." && \
    curl -sL "$URL" -o /tmp/moq.tar.gz && \
    tar -xzf /tmp/moq.tar.gz -C /tmp && \
    mv /tmp/moq-cli-*/bin/moq /usr/local/bin/moq && \
    chmod +x /usr/local/bin/moq && \
    rm -rf /tmp/moq* && \
    mkdir -p /usr/local/share && : > /usr/local/share/moq-cli-build

# moq-cli compilado desde un commit, con MOQ_CLI_FROM=git. Perfil release con LTO thin: el LTO completo del
# proyecto no cupo en los 7,7 GB de la máquina virtual de Docker de un Mac (21-10-2026). Solo el transporte
# QUIC, que es el que usa el testbed hacia el relay; las demás funcionalidades por defecto (WebRTC, almacenes
# en la nube, NVIDIA...) no se usan.
# Las cachés de Cargo persisten entre construcciones: cambiar de commit reutiliza las dependencias compiladas.
# El binario se identifica como git@<commit> en el panel de versiones y en el CSV (ver versions.py).
FROM rust:1.98.1-bookworm AS moqcli-git
ARG MOQ_CLI_COMMIT=bc64b9c52561209322dcb8dec9992bf867f499f7
ARG MOQ_CLI_FEATURES=quic
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /src && curl -fsSL "https://codeload.github.com/moq-dev/moq/tar.gz/${MOQ_CLI_COMMIT}" | tar -xz -C /src --strip-components=1
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/target \
    cd /src && CARGO_TARGET_DIR=/target CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    cargo build --release --locked -p moq-cli --no-default-features --features "${MOQ_CLI_FEATURES}" && \
    install -m 755 /target/release/moq /usr/local/bin/moq && \
    mkdir -p /usr/local/share && printf 'git@%.7s' "${MOQ_CLI_COMMIT}" > /usr/local/share/moq-cli-build

FROM moqcli-${MOQ_CLI_FROM} AS moqcli

FROM python:3.12-slim

# Instalar FFmpeg, fuentes tipográficas para drawtext, openssl, ca-certificates y tar
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    openssl \
    curl \
    ca-certificates \
    tar \
    gzip \
    && rm -rf /var/lib/apt/lists/*

# moq-cli: el publicador de MoQ, de una de las dos etapas de arriba según MOQ_CLI_FROM
COPY --from=moqcli /usr/local/bin/moq /usr/local/bin/moq
COPY --from=moqcli /usr/local/share/moq-cli-build /usr/local/share/moq-cli-build

COPY --from=vmaf /usr/local/bin/vmaf /usr/local/bin/vmaf

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
