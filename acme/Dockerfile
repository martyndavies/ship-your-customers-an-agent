FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app

# Install acme_diagnostics' dependencies from the lockfile into its own venv.
COPY acme_diagnostics/pyproject.toml acme_diagnostics/uv.lock acme_diagnostics/.python-version ./acme_diagnostics/
RUN cd acme_diagnostics && uv sync --frozen --no-dev

COPY acme_diagnostics/agent-card.json acme_diagnostics/handler.py ./acme_diagnostics/
COPY webhook-receiver/receiver.py ./webhook-receiver/
COPY start.py ./

# The venv's python and blocks-run come first on PATH, so start.py and the
# processes it launches all use the locked environment.
ENV PATH="/app/acme_diagnostics/.venv/bin:$PATH" \
    UV_NO_SYNC=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8787 \
    ACME_LOG_PATH=/app/data/webhook-handler.log

# BLOCKS_API_KEY and WEBHOOK_SECRET are supplied at runtime with `fly secrets`,
# never baked into the image.
CMD ["python", "start.py"]
