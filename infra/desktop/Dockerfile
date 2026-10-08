FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-tk xvfb openbox xterm x11-apps x11-utils scrot xclip fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /opt/openmuse/requirements.txt
RUN python3 -m venv --system-site-packages /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /opt/openmuse/requirements.txt && useradd -m -u 1000 desktop
COPY driver.py entrypoint.sh /opt/openmuse/
USER 1000:1000
ENV DISPLAY=:99 XDG_SESSION_TYPE=x11 OPENMUSE_VIRTUAL_DESKTOP=1 HOME=/home/desktop PATH=/opt/venv/bin:/usr/bin:/bin
WORKDIR /home/desktop
ENTRYPOINT ["/bin/sh", "/opt/openmuse/entrypoint.sh"]
