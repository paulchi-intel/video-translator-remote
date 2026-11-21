# Video Translator Remote — ffmpeg job server (CPU only)
FROM ubuntu:24.04

ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg (with libass for burned-in subtitles), CJK fonts, numpy + soundfile for mixing
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-cjk fontconfig \
      python3 python3-numpy python3-soundfile \
 && rm -rf /var/lib/apt/lists/*

COPY vt_server.py /app/vt_server.py

ENV VT_DATA_DIR=/data \
    VT_PORT=17497 \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 17497
WORKDIR /app
CMD ["python3", "/app/vt_server.py"]
