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
    rm -rf /tmp/moq*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
