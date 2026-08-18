FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .
RUN python -m livekit.agents download-files

ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn src.service:app --host 0.0.0.0 --port ${PORT}"]
