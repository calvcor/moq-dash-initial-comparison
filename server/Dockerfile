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
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
        URL="https://github.com/moq-dev/moq/releases/download/moq-cli-v0.14.2/moq-cli-v0.14.2-aarch64-unknown-linux-gnu.tar.gz"; \
    else \
        URL="https://github.com/moq-dev/moq/releases/download/moq-cli-v0.14.2/moq-cli-v0.14.2-x86_64-unknown-linux-gnu.tar.gz"; \
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
