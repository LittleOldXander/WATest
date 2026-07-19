FROM grafana/k6:1.7.1

USER root

# The stock k6 image does not include Docker Compose. The load harness uses
# it only to create and recover a deliberate Redis outage.
RUN apk add --no-cache curl docker-cli docker-cli-compose

WORKDIR /workspace
