#!/usr/bin/env bash

# Side-effect-free machine clock for resource-log.sh. Keeping it separate lets
# the UTC record contract be tested without sampling the verification host.
resource_record_ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
